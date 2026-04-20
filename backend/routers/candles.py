"""
Candles API — serves raw OHLCV bars for the Superchart.

GET /api/candles?pair=EURUSD&timeframe=1H&start=2023-01-01&end=2024-12-31&limit=2000

Stored timeframes (1m, 1H) are queried directly.
Derived timeframes (5m, 15m, 30m, 4H, 1D) are resampled on-the-fly from 1m data.
"""

import datetime
import logging
from typing import Annotated

import pandas as pd
from fastapi import APIRouter, Depends, HTTPException, Query

from core.auth import TokenData, get_current_user
from core.db import get_pool

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/candles", tags=["Candles"])

_STORED_TIMEFRAMES = {"1m", "1H"}
_RESAMPLE_RULES: dict[str, str] = {
    "5m":  "5min",
    "15m": "15min",
    "30m": "30min",
    "4H":  "4h",
    "1D":  "1D",
}
_OHLCV_AGG = {"open": "first", "high": "max", "low": "min", "close": "last"}


@router.get("")
async def get_candles(
    pair: str = Query(..., description="Currency pair e.g. EURUSD"),
    timeframe: str = Query(default="1H", description="Timeframe: 1m, 5m, 15m, 30m, 1H, 4H, 1D"),
    start: str | None = Query(default=None, description="ISO date start (inclusive)"),
    end: str | None = Query(default=None, description="ISO date end (inclusive)"),
    limit: int = Query(default=2000, ge=1, le=10000),
    _: Annotated[TokenData | None, Depends(get_current_user)] = None,
) -> dict:
    """
    Return OHLCV candles ordered ascending (oldest first).

    Stored timeframes (1m, 1H) are queried directly.
    Derived timeframes (5m, 15m, 30m, 4H, 1D) are resampled on-the-fly from 1m data.
    When no date range is given the most recent `limit` bars are returned.
    """
    pair = pair.upper().replace("/", "")

    if timeframe not in _STORED_TIMEFRAMES and timeframe not in _RESAMPLE_RULES:
        raise HTTPException(status_code=400, detail=f"Unsupported timeframe: {timeframe!r}")

    derived = timeframe not in _STORED_TIMEFRAMES
    fetch_tf = "1m" if derived else timeframe

    pool = await get_pool()
    async with pool.acquire() as conn:
        params: list = [pair, fetch_tf]
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
        # For derived TFs we over-fetch 1m rows; limit is applied after resample.
        # For stored TFs without a date range, fetch newest rows then reverse.
        order = "ASC" if (start or end) else "DESC"
        fetch_limit = limit * 300 if derived else limit  # 300 1m bars per 4H bar worst-case

        rows = await conn.fetch(
            f"""
            SELECT timestamp, open, high, low, close
            FROM ohlcv_candles
            WHERE {where}
            ORDER BY timestamp {order}
            LIMIT ${len(params) + 1}
            """,
            *params,
            fetch_limit,
        )

        if order == "DESC":
            rows = list(reversed(rows))

    if not rows:
        return {"pair": pair, "timeframe": timeframe, "candles": []}

    if derived:
        rule = _RESAMPLE_RULES[timeframe]
        df = pd.DataFrame(
            [{"timestamp": r["timestamp"],
              "open": float(r["open"]), "high": float(r["high"]),
              "low": float(r["low"]),  "close": float(r["close"])} for r in rows]
        )
        df["timestamp"] = pd.to_datetime(df["timestamp"], utc=True)
        df = df.set_index("timestamp").sort_index()
        df = (
            df.resample(rule, label="left", closed="left")
            .agg(_OHLCV_AGG)
            .dropna(subset=["close"])
            .tail(limit)
        )
        candles = [
            {
                "time": int(ts.timestamp()),
                "open": row["open"], "high": row["high"],
                "low": row["low"],   "close": row["close"],
            }
            for ts, row in df.iterrows()
        ]
    else:
        candles = [
            {
                "time": int(r["timestamp"].timestamp()),
                "open": float(r["open"]), "high": float(r["high"]),
                "low": float(r["low"]),   "close": float(r["close"]),
            }
            for r in rows
        ]

    return {"pair": pair, "timeframe": timeframe, "candles": candles}


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
