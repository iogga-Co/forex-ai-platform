"""
News / Economic Calendar endpoints.

GET /api/news/calendar
  Query params:
    from        ISO date string YYYY-MM-DD (default: today)
    to          ISO date string YYYY-MM-DD (default: today + 7 days)
    currencies  comma-separated, e.g. "USD,EUR,GBP" (default: all 5)
    impact      "high" | "medium" | "low" | "all" (default: "all")

Data is fetched from the ForexFactory unofficial JSON feed, cached in Redis
for 1 hour per ISO week, and persisted in the news_events table for
historical correlation queries.
"""

import json
import logging
from datetime import date, datetime, timedelta, timezone
from typing import Annotated
from zoneinfo import ZoneInfo

import httpx
import redis.asyncio as aioredis
from fastapi import APIRouter, Depends, HTTPException, Query

from core.auth import TokenData, get_current_user
from core.config import settings
from core.db import get_pool

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/news", tags=["News"])

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

FF_BASE = "https://nfs.faireconomy.media"
FF_URLS = {
    "thisweek": f"{FF_BASE}/ff_calendar_thisweek.json",
    "nextweek": f"{FF_BASE}/ff_calendar_nextweek.json",
    "lastweek": f"{FF_BASE}/ff_calendar_lastweek.json",
}

# Maps a currency to the traded pairs it directly affects
CURRENCY_TO_PAIRS: dict[str, list[str]] = {
    "USD": ["EURUSD", "GBPUSD", "USDJPY", "USDCHF"],
    "EUR": ["EURUSD", "EURGBP"],
    "GBP": ["GBPUSD", "EURGBP", "GBPJPY"],
    "JPY": ["USDJPY", "GBPJPY"],
    "CHF": ["USDCHF"],
}

ALL_CURRENCIES = {"USD", "EUR", "GBP", "JPY", "CHF"}

ET_ZONE = ZoneInfo("America/New_York")

# Cache TTL in seconds
CACHE_TTL = 3600


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _iso_week_key(d: date) -> str:
    """Return Redis cache key for the ISO week containing date d."""
    iso = d.isocalendar()
    return f"news:calendar:{iso.year}-W{iso.week:02d}"


def _ff_week_label(d: date) -> str:
    """
    Map a date to the ForexFactory weekly feed label: 'lastweek', 'thisweek', 'nextweek'.
    Returns 'thisweek' for dates outside that ±1 week window (best effort).
    """
    today = date.today()
    # Start of current ISO week (Monday)
    week_start = today - timedelta(days=today.weekday())
    if d < week_start:
        return "lastweek"
    if d >= week_start + timedelta(weeks=1):
        return "nextweek"
    return "thisweek"


def _parse_ff_time(date_str: str, time_str: str) -> datetime | None:
    """
    Parse a ForexFactory date/time pair to a UTC datetime.

    date_str examples: "Apr 16, 2025", "Apr 16, 2026"
    time_str examples:  "8:30am", "2:00pm", "All Day", "Tentative", ""
    """
    try:
        d = datetime.strptime(date_str.strip(), "%b %d, %Y")
    except ValueError:
        return None

    time_str = time_str.strip().lower()
    if not time_str or time_str in ("all day", "tentative", ""):
        # No exact time — use midnight ET
        naive = d.replace(hour=0, minute=0, second=0)
    else:
        try:
            # Handle 12-hour format
            fmt = "%I:%M%p" if ":" in time_str else "%I%p"
            t = datetime.strptime(time_str, fmt)
            naive = d.replace(hour=t.hour, minute=t.minute, second=0)
        except ValueError:
            naive = d.replace(hour=0, minute=0, second=0)

    # Attach ET timezone, convert to UTC
    aware_et = naive.replace(tzinfo=ET_ZONE)
    return aware_et.astimezone(timezone.utc)


def _normalise_impact(raw: str) -> str:
    mapping = {"high": "high", "medium": "medium", "low": "low",
               "non-economic": "low", "holiday": "low"}
    return mapping.get(raw.lower(), "low")


def _affected_pairs(currency: str) -> list[str]:
    return CURRENCY_TO_PAIRS.get(currency.upper(), [])


async def _fetch_ff_week(label: str) -> list[dict]:
    """Fetch a ForexFactory weekly JSON feed. Returns raw list or []."""
    url = FF_URLS.get(label, FF_URLS["thisweek"])
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(url, follow_redirects=True)
            resp.raise_for_status()
            return resp.json()
    except Exception as exc:
        logger.warning("ForexFactory fetch failed (%s): %s", label, exc)
        return []


def _raw_to_event(item: dict) -> dict | None:
    """Convert a raw FF dict to our normalised event dict. Returns None if unparseable."""
    event_time = _parse_ff_time(item.get("date", ""), item.get("time", ""))
    if event_time is None:
        return None
    currency = item.get("country", "").upper()
    if not currency:
        return None
    return {
        "event_time": event_time,
        "currency": currency,
        "title": item.get("title", "").strip(),
        "impact": _normalise_impact(item.get("impact", "")),
        "forecast": item.get("forecast") or None,
        "actual": item.get("actual") or None,
        "previous": item.get("previous") or None,
        "source": "forexfactory",
        "affected_pairs": _affected_pairs(currency),
    }


# ---------------------------------------------------------------------------
# GET /api/news/calendar
# ---------------------------------------------------------------------------

@router.get("/calendar")
async def get_calendar(
    from_date: str = Query(default=None, alias="from"),
    to_date:   str = Query(default=None, alias="to"),
    currencies: str = Query(default="USD,EUR,GBP,JPY,CHF"),
    impact:     str = Query(default="all"),
    _: Annotated[TokenData | None, Depends(get_current_user)] = None,
) -> dict:
    """
    Return economic calendar events for the requested date range.
    Events are fetched from ForexFactory, cached in Redis (1 h), and
    persisted to news_events for historical correlation queries.
    """
    today = date.today()

    # Parse date params
    try:
        date_from = date.fromisoformat(from_date) if from_date else today
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid 'from' date format. Use YYYY-MM-DD.")
    try:
        date_to = date.fromisoformat(to_date) if to_date else today + timedelta(days=7)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid 'to' date format. Use YYYY-MM-DD.")

    # Parse currency filter
    requested_currencies = {c.strip().upper() for c in currencies.split(",") if c.strip()}
    if not requested_currencies:
        requested_currencies = ALL_CURRENCIES

    # Determine which ISO weeks the range spans
    weeks_needed: set[str] = set()
    d = date_from
    while d <= date_to:
        weeks_needed.add(_ff_week_label(d))
        d += timedelta(weeks=1)
        if d > date_to and date_to >= date_from:
            break
    # Always include the week of date_to
    weeks_needed.add(_ff_week_label(date_to))

    # Fetch & cache each needed week
    r = aioredis.from_url(settings.redis_url, decode_responses=True)
    all_events: list[dict] = []
    thisweek_failed = False

    try:
        for week_label in weeks_needed:
            cache_key = f"news:ff:{week_label}"
            cached = await r.get(cache_key)

            if cached:
                raw_list = json.loads(cached)
            else:
                raw_list = await _fetch_ff_week(week_label)
                if raw_list:
                    await r.setex(cache_key, CACHE_TTL, json.dumps(raw_list))
                else:
                    # lastweek/nextweek returning 404 is normal — ForexFactory
                    # doesn't always publish those feeds. Only flag stale if
                    # thisweek itself fails.
                    if week_label == "thisweek":
                        thisweek_failed = True

            for item in raw_list:
                event = _raw_to_event(item)
                if event:
                    all_events.append(event)
    finally:
        await r.aclose()

    stale = thisweek_failed

    # Persist to DB (upsert) in background — don't block the response
    if all_events:
        try:
            pool = await get_pool()
            async with pool.acquire() as conn:
                await conn.executemany(
                    """
                    INSERT INTO news_events
                        (event_time, currency, title, impact, forecast, actual, previous, source)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                    ON CONFLICT (event_time, currency, title)
                        DO UPDATE SET
                            actual     = EXCLUDED.actual,
                            forecast   = EXCLUDED.forecast,
                            previous   = EXCLUDED.previous,
                            fetched_at = now()
                    """,
                    [
                        (
                            e["event_time"], e["currency"], e["title"], e["impact"],
                            e["forecast"], e["actual"], e["previous"], e["source"],
                        )
                        for e in all_events
                    ],
                )
        except Exception as exc:
            logger.warning("news_events upsert failed: %s", exc)

    # Filter by date range, currencies, impact
    dt_from = datetime.combine(date_from, datetime.min.time(), tzinfo=timezone.utc)
    dt_to   = datetime.combine(date_to,   datetime.max.time(), tzinfo=timezone.utc)

    filtered = [
        e for e in all_events
        if dt_from <= e["event_time"] <= dt_to
        and e["currency"] in requested_currencies
        and (impact == "all" or e["impact"] == impact)
    ]

    # Sort by event_time ascending
    filtered.sort(key=lambda e: e["event_time"])

    # Serialise datetimes
    now_utc = datetime.now(timezone.utc)
    result_events = []
    for e in filtered:
        result_events.append({
            "event_time":    e["event_time"].isoformat(),
            "currency":      e["currency"],
            "title":         e["title"],
            "impact":        e["impact"],
            "forecast":      e["forecast"],
            "actual":        e["actual"],
            "previous":      e["previous"],
            "affected_pairs": e["affected_pairs"],
            "is_past":       e["event_time"] < now_utc,
            "is_upcoming":   abs((e["event_time"] - now_utc).total_seconds()) <= 1800,  # ±30 min
        })

    return {
        "events": result_events,
        "stale":  stale,
        "count":  len(result_events),
    }
