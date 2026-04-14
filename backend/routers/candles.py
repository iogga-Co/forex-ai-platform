"""
Candles API — serves raw OHLCV bars for the Superchart.

GET /api/candles?pair=EURUSD&timeframe=1H&start=2023-01-01&end=2024-12-31&limit=2000
"""

import datetime
import logging
from typing import Annotated

from fastapi import APIRouter, Depends, Query

from core.auth import TokenData, get_current_user
from core.db import get_pool

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/candles", tags=["Candles"])


@router.get("")
async def get_candles(
    pair: str = Query(..., description="Currency pair e.g. EURUSD"),
    timeframe: str = Query(default="1H", description="Timeframe: 1m or 1H"),
    start: str | None = Query(default=None, description="ISO date start (inclusive)"),
    end: str | None = Query(default=None, description="ISO date end (inclusive)"),
    limit: int = Query(default=2000, ge=1, le=10000),
    _: Annotated[TokenData | None, Depends(get_current_user)] = None,
) -> dict:
    """
    Return OHLCV candles ordered ascending (oldest first).
    When no date range is given the most recent `limit` bars are returned.
    """
    pair = pair.upper().replace("/", "")

    pool = await get_pool()
    async with pool.acquire() as conn:
        params: list = [pair, timeframe]
        where_clauses = ["pair = $1", "timeframe = $2"]

        if start:
            start_dt = _parse_date(start)
            where_clauses.append(f"timestamp >= ${len(params) + 1}")
            params.append(start_dt)

        if end:
            end_dt = _parse_date(end, end_of_day=True)
            where_clauses.append(f"timestamp <= ${len(params) + 1}")
            params.append(end_dt)

        where = " AND ".join(where_clauses)
        # Without a date range fetch newest rows then reverse; with a range go ASC directly.
        order = "ASC" if (start or end) else "DESC"

        rows = await conn.fetch(
            f"""
            SELECT timestamp, open, high, low, close
            FROM ohlcv_candles
            WHERE {where}
            ORDER BY timestamp {order}
            LIMIT ${len(params) + 1}
            """,
            *params,
            limit,
        )

        if order == "DESC":
            rows = list(reversed(rows))

    return {
        "pair": pair,
        "timeframe": timeframe,
        "candles": [
            {
                "time": int(r["timestamp"].timestamp()),
                "open": float(r["open"]),
                "high": float(r["high"]),
                "low": float(r["low"]),
                "close": float(r["close"]),
            }
            for r in rows
        ],
    }


def _parse_date(s: str, end_of_day: bool = False) -> datetime.datetime:
    try:
        dt = datetime.datetime.fromisoformat(s)
    except ValueError:
        dt = datetime.datetime.strptime(s[:10], "%Y-%m-%d")
        if end_of_day:
            dt = dt.replace(hour=23, minute=59, second=59)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=datetime.timezone.utc)
    return dt
