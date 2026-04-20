"""
Indicator Lab API.

Stateless compute endpoints (no auth required for compute — results contain
no sensitive data).  CRUD endpoints for saved indicators require auth.

POST /api/lab/indicators          — compute indicator series from a config
POST /api/lab/signals             — compute entry-signal timestamps
GET  /api/lab/indicators/saved    — list saved indicators for current user
POST /api/lab/indicators/saved    — create a saved indicator
PUT  /api/lab/indicators/saved/{id} — update name / status / config
DELETE /api/lab/indicators/saved/{id} — delete
POST /api/lab/analyze             — SSE: Claude analysis of current chart state
"""

from __future__ import annotations

import datetime
import logging
from typing import Annotated
from uuid import UUID

import numpy as np
import pandas as pd
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from core.auth import TokenData, get_current_user, get_current_user_sse
from core.db import get_pool
from engine.indicators import (
    adx as calc_adx,
    atr as calc_atr,
    bollinger_bands as calc_bb,
    ema as calc_ema,
    macd as calc_macd,
    rsi as calc_rsi,
    sma as calc_sma,
    stochastic as calc_stoch,
)

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/lab", tags=["Indicator Lab"])

# ---------------------------------------------------------------------------
# Shared resample helpers (mirrors routers/candles.py)
# ---------------------------------------------------------------------------
_STORED_TF   = {"1m", "1H"}
_RESAMPLE    = {"5m": "5min", "15m": "15min", "30m": "30min", "4H": "4h", "1D": "1D"}
_OHLCV_AGG   = {"open": "first", "high": "max", "low": "min", "close": "last"}
_VALID_TF    = _STORED_TF | set(_RESAMPLE)


def _parse_date(s: str) -> datetime.datetime:
    try:
        dt = datetime.datetime.fromisoformat(s)
    except ValueError:
        dt = datetime.datetime.strptime(s[:10], "%Y-%m-%d")
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=datetime.timezone.utc)
    return dt


async def _fetch_df(conn, pair: str, timeframe: str, from_dt: datetime.datetime, to_dt: datetime.datetime) -> pd.DataFrame:
    """Fetch OHLCV as a float64 DataFrame, resampling from 1m if needed."""
    fetch_tf = "1m" if timeframe not in _STORED_TF else timeframe
    rows = await conn.fetch(
        """
        SELECT timestamp, open, high, low, close
        FROM ohlcv_candles
        WHERE pair = $1 AND timeframe = $2
          AND timestamp >= $3 AND timestamp <= $4
        ORDER BY timestamp ASC
        """,
        pair.upper(), fetch_tf, from_dt, to_dt,
    )
    if not rows:
        return pd.DataFrame(columns=["open", "high", "low", "close"], dtype="float64")

    df = pd.DataFrame([
        {"ts": r["timestamp"],
         "open": float(r["open"]), "high": float(r["high"]),
         "low": float(r["low"]),  "close": float(r["close"])}
        for r in rows
    ])
    df["ts"] = pd.to_datetime(df["ts"], utc=True)
    df = df.set_index("ts").sort_index()

    if timeframe not in _STORED_TF:
        df = (
            df.resample(_RESAMPLE[timeframe], label="left", closed="left")
            .agg({**_OHLCV_AGG, "low": "min"})
            .dropna(subset=["close"])
        )
    return df.astype("float64")


# ---------------------------------------------------------------------------
# Indicator computation helpers
# ---------------------------------------------------------------------------
_OVERLAY_COLORS = ["#3b82f6", "#f59e0b", "#a855f7", "#06b6d4", "#f97316"]
_OSC_COLORS = {
    "RSI":   "#06b6d4",
    "MACD":  "#3b82f6",
    "ADX":   "#a855f7",
    "STOCH": "#22d3ee",
    "ATR":   "#94a3b8",
}


def _series_to_data(ts_index: pd.Index, values: pd.Series) -> list[dict]:
    out = []
    for ts, v in zip(ts_index, values):
        if pd.isna(v) or not np.isfinite(float(v)):
            continue
        out.append({"time": int(ts.timestamp()), "value": float(v)})
    return out


def _compute_indicators(df: pd.DataFrame, indicators: list[dict]) -> list[dict]:
    """
    Compute indicator series from a DataFrame and indicator config list.
    Returns the same schema as GET /api/analytics/backtest/{id}/indicators.
    """
    close  = df["close"]
    high   = df["high"]
    low    = df["low"]
    idx    = df.index
    result = []
    overlay_ci = 0

    for spec in indicators:
        itype  = spec["type"].upper()
        params = spec.get("params", {})
        color  = spec.get("color") or _OVERLAY_COLORS[overlay_ci % len(_OVERLAY_COLORS)]

        try:
            if itype == "EMA":
                p = int(params.get("period", 20))
                result.append({
                    "id": f"EMA_{p}", "type": "EMA", "pane": "overlay",
                    "series": [{"name": f"EMA {p}", "color": color,
                                "data": _series_to_data(idx, calc_ema(close, p))}],
                })
                overlay_ci += 1

            elif itype == "SMA":
                p = int(params.get("period", 50))
                result.append({
                    "id": f"SMA_{p}", "type": "SMA", "pane": "overlay",
                    "series": [{"name": f"SMA {p}", "color": color,
                                "data": _series_to_data(idx, calc_sma(close, p))}],
                })
                overlay_ci += 1

            elif itype == "BB":
                p  = int(params.get("period", 20))
                sd = float(params.get("std_dev", 2.0))
                upper, middle, lower = calc_bb(close, p, sd)
                result.append({
                    "id": f"BB_{p}", "type": "BB", "pane": "overlay",
                    "series": [
                        {"name": "BB Upper", "color": color, "data": _series_to_data(idx, upper)},
                        {"name": "BB Mid",   "color": color, "data": _series_to_data(idx, middle)},
                        {"name": "BB Lower", "color": color, "data": _series_to_data(idx, lower)},
                    ],
                })
                overlay_ci += 1

            elif itype == "RSI":
                p = int(params.get("period", 14))
                result.append({
                    "id": f"RSI_{p}", "type": "RSI", "pane": "oscillator",
                    "levels": [{"value": 70, "color": "#ef4444"}, {"value": 30, "color": "#22c55e"}],
                    "series": [{"name": f"RSI {p}", "color": _OSC_COLORS["RSI"],
                                "data": _series_to_data(idx, calc_rsi(close, p))}],
                })

            elif itype == "MACD":
                fast = int(params.get("fast", 12))
                slow = int(params.get("slow", 26))
                sig  = int(params.get("signal_period", 9))
                line, signal, hist = calc_macd(close, fast, slow, sig)
                hist_data = []
                for ts, v in zip(idx, hist):
                    if pd.isna(v) or not np.isfinite(float(v)):
                        continue
                    hist_data.append({"time": int(ts.timestamp()), "value": float(v),
                                      "color": "#22c55e99" if float(v) >= 0 else "#ef444499"})
                result.append({
                    "id": f"MACD_{fast}_{slow}", "type": "MACD", "pane": "oscillator",
                    "series": [
                        {"name": "MACD",   "color": _OSC_COLORS["MACD"],  "data": _series_to_data(idx, line)},
                        {"name": "Signal", "color": "#f97316",             "data": _series_to_data(idx, signal)},
                        {"name": "Hist",   "color": "#6b7280",             "data": hist_data, "style": "histogram"},
                    ],
                })

            elif itype == "ADX":
                p = int(params.get("period", 14))
                result.append({
                    "id": f"ADX_{p}", "type": "ADX", "pane": "oscillator",
                    "levels": [{"value": 25, "color": "#6b7280"}],
                    "series": [{"name": f"ADX {p}", "color": _OSC_COLORS["ADX"],
                                "data": _series_to_data(idx, calc_adx(high, low, close, p))}],
                })

            elif itype == "STOCH":
                p  = int(params.get("period", 14))
                ks = int(params.get("k_smooth", 3))
                dp = int(params.get("d_period", 3))
                k, d = calc_stoch(high, low, close, p, ks, dp)
                result.append({
                    "id": f"STOCH_{p}", "type": "STOCH", "pane": "oscillator",
                    "levels": [{"value": 80, "color": "#ef4444"}, {"value": 20, "color": "#22c55e"}],
                    "series": [
                        {"name": "%K", "color": _OSC_COLORS["STOCH"], "data": _series_to_data(idx, k)},
                        {"name": "%D", "color": "#f97316",             "data": _series_to_data(idx, d)},
                    ],
                })

            elif itype == "ATR":
                p = int(params.get("period", 14))
                result.append({
                    "id": f"ATR_{p}", "type": "ATR", "pane": "oscillator",
                    "series": [{"name": f"ATR {p}", "color": _OSC_COLORS["ATR"],
                                "data": _series_to_data(idx, calc_atr(high, low, close, p))}],
                })

        except Exception as exc:
            logger.warning("Lab indicator %s failed: %s", itype, exc)

    return result


# ---------------------------------------------------------------------------
# Request / Response models
# ---------------------------------------------------------------------------

class IndicatorSpec(BaseModel):
    type: str
    params: dict = Field(default_factory=dict)
    color: str | None = None


class ComputeRequest(BaseModel):
    pair: str
    timeframe: str = "1H"
    from_date: str = Field(alias="from")
    to_date: str   = Field(alias="to")
    indicators: list[IndicatorSpec] = Field(default_factory=list)

    model_config = {"populate_by_name": True}


class ConditionSpec(BaseModel):
    indicator: str
    operator: str        # ">", "<", "price_above", "price_below", "crossed_above", "crossed_below"
    period: int = 14
    value: float | None = None
    fast: int | None = None
    slow: int | None = None
    signal_period: int | None = None
    std_dev: float | None = None
    k_smooth: int | None = None
    d_period: int | None = None


class SignalsRequest(BaseModel):
    pair: str
    timeframe: str = "1H"
    from_date: str = Field(alias="from")
    to_date: str   = Field(alias="to")
    indicators: list[IndicatorSpec] = Field(default_factory=list)
    conditions: list[ConditionSpec] = Field(default_factory=list)

    model_config = {"populate_by_name": True}


class SavedIndicatorCreate(BaseModel):
    name: str = ""
    status: str = "draft"
    indicator_config: dict = Field(default_factory=lambda: {"indicators": []})
    signal_conditions: list = Field(default_factory=list)


class SavedIndicatorUpdate(BaseModel):
    name: str | None = None
    status: str | None = None
    indicator_config: dict | None = None
    signal_conditions: list | None = None


# ---------------------------------------------------------------------------
# POST /api/lab/indicators — compute (stateless)
# ---------------------------------------------------------------------------

@router.post("/indicators")
async def compute_indicators(
    payload: ComputeRequest,
    pool=Depends(get_pool),
) -> dict:
    """Compute indicator series for a given config. No auth required."""
    if payload.timeframe not in _VALID_TF:
        raise HTTPException(status_code=400, detail=f"Unsupported timeframe: {payload.timeframe!r}")

    from_dt = _parse_date(payload.from_date)
    to_dt   = _parse_date(payload.to_date)

    async with pool.acquire() as conn:
        df = await _fetch_df(conn, payload.pair, payload.timeframe, from_dt, to_dt)

    if df.empty:
        return {"indicators": []}

    specs = [{"type": s.type, "params": s.params, "color": s.color} for s in payload.indicators]
    return {"indicators": _compute_indicators(df, specs)}


# ---------------------------------------------------------------------------
# POST /api/lab/signals — compute signal timestamps (stateless)
# ---------------------------------------------------------------------------

@router.post("/signals")
async def compute_signals(
    payload: SignalsRequest,
    pool=Depends(get_pool),
) -> dict:
    """
    Return bar timestamps where all conditions are simultaneously true.
    Conditions reference indicator values computed on-the-fly.
    """
    if payload.timeframe not in _VALID_TF:
        raise HTTPException(status_code=400, detail=f"Unsupported timeframe: {payload.timeframe!r}")

    from_dt = _parse_date(payload.from_date)
    to_dt   = _parse_date(payload.to_date)

    async with pool.acquire() as conn:
        df = await _fetch_df(conn, payload.pair, payload.timeframe, from_dt, to_dt)

    if df.empty or not payload.conditions:
        return {"signals": []}

    close = df["close"]
    high  = df["high"]
    low   = df["low"]

    # Build a boolean mask — all conditions must be true simultaneously
    mask = pd.Series(True, index=df.index)

    for cond in payload.conditions:
        ind = cond.indicator.upper()
        op  = cond.operator
        try:
            if ind == "EMA":
                series = calc_ema(close, cond.period)
            elif ind == "SMA":
                series = calc_sma(close, cond.period)
            elif ind == "RSI":
                series = calc_rsi(close, cond.period)
            elif ind == "ATR":
                series = calc_atr(high, low, close, cond.period)
            elif ind == "ADX":
                series = calc_adx(high, low, close, cond.period)
            elif ind == "MACD":
                fast = cond.fast or 12
                slow = cond.slow or 26
                sig  = cond.signal_period or 9
                series, _, _ = calc_macd(close, fast, slow, sig)
            elif ind == "BB":
                sd = cond.std_dev or 2.0
                upper, middle, lower = calc_bb(close, cond.period, sd)
                series = upper  # default — conditions reference upper band
            elif ind == "STOCH":
                ks = cond.k_smooth or 3
                dp = cond.d_period or 3
                series, _ = calc_stoch(high, low, close, cond.period, ks, dp)
            else:
                continue

            val = cond.value if cond.value is not None else 0.0

            if op == ">":
                mask &= series > val
            elif op == "<":
                mask &= series < val
            elif op == "price_above":
                mask &= close > series
            elif op == "price_below":
                mask &= close < series
            elif op == "crossed_above":
                mask &= (close > series) & (close.shift(1) <= series.shift(1))
            elif op == "crossed_below":
                mask &= (close < series) & (close.shift(1) >= series.shift(1))

        except Exception as exc:
            logger.warning("Lab signal condition %s %s failed: %s", ind, op, exc)

    signal_times = [int(ts.timestamp()) for ts in df.index[mask.fillna(False)]]
    return {"signals": signal_times}


# ---------------------------------------------------------------------------
# Saved indicator CRUD
# ---------------------------------------------------------------------------

def _row_to_saved(row) -> dict:
    return {
        "id":                str(row["id"]),
        "name":              row["name"],
        "status":            row["status"],
        "indicator_config":  dict(row["indicator_config"]) if row["indicator_config"] else {"indicators": []},
        "signal_conditions": list(row["signal_conditions"]) if row["signal_conditions"] else [],
        "created_at":        row["created_at"].isoformat() if row["created_at"] else None,
        "updated_at":        row["updated_at"].isoformat() if row["updated_at"] else None,
    }


@router.get("/indicators/saved")
async def list_saved_indicators(
    user: Annotated[TokenData, Depends(get_current_user)],
    pool=Depends(get_pool),
) -> list[dict]:
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT id, name, status, indicator_config, signal_conditions, created_at, updated_at
            FROM saved_indicators
            WHERE user_id = $1
            ORDER BY updated_at DESC
            """,
            user.sub,
        )
    return [_row_to_saved(r) for r in rows]


@router.post("/indicators/saved", status_code=201)
async def create_saved_indicator(
    payload: SavedIndicatorCreate,
    user: Annotated[TokenData, Depends(get_current_user)],
    pool=Depends(get_pool),
) -> dict:
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            INSERT INTO saved_indicators (user_id, name, status, indicator_config, signal_conditions)
            VALUES ($1, $2, $3, $4, $5)
            RETURNING id, name, status, indicator_config, signal_conditions, created_at, updated_at
            """,
            user.sub,
            payload.name,
            payload.status,
            payload.indicator_config,
            payload.signal_conditions,
        )
    return _row_to_saved(row)


@router.put("/indicators/saved/{indicator_id}")
async def update_saved_indicator(
    indicator_id: UUID,
    payload: SavedIndicatorUpdate,
    user: Annotated[TokenData, Depends(get_current_user)],
    pool=Depends(get_pool),
) -> dict:
    async with pool.acquire() as conn:
        existing = await conn.fetchrow(
            "SELECT id FROM saved_indicators WHERE id = $1 AND user_id = $2",
            str(indicator_id), user.sub,
        )
        if existing is None:
            raise HTTPException(status_code=404, detail="Indicator not found")

        updates: list[str] = ["updated_at = NOW()"]
        params: list       = []

        if payload.name is not None:
            params.append(payload.name)
            updates.append(f"name = ${len(params)}")
        if payload.status is not None:
            params.append(payload.status)
            updates.append(f"status = ${len(params)}")
        if payload.indicator_config is not None:
            params.append(payload.indicator_config)
            updates.append(f"indicator_config = ${len(params)}")
        if payload.signal_conditions is not None:
            params.append(payload.signal_conditions)
            updates.append(f"signal_conditions = ${len(params)}")

        params.append(str(indicator_id))
        row = await conn.fetchrow(
            f"""
            UPDATE saved_indicators SET {', '.join(updates)}
            WHERE id = ${len(params)}
            RETURNING id, name, status, indicator_config, signal_conditions, created_at, updated_at
            """,
            *params,
        )
    return _row_to_saved(row)


@router.delete("/indicators/saved/{indicator_id}", status_code=204, response_model=None)
async def delete_saved_indicator(
    indicator_id: UUID,
    user: Annotated[TokenData, Depends(get_current_user)],
    pool=Depends(get_pool),
) -> None:
    async with pool.acquire() as conn:
        result = await conn.execute(
            "DELETE FROM saved_indicators WHERE id = $1 AND user_id = $2",
            str(indicator_id), user.sub,
        )
    if result == "DELETE 0":
        raise HTTPException(status_code=404, detail="Indicator not found")


# ---------------------------------------------------------------------------
# POST /api/lab/analyze — SSE (stub for PR 4)
# ---------------------------------------------------------------------------

@router.post("/analyze")
async def analyze_chart(
    _user: Annotated[TokenData, Depends(get_current_user_sse)],
) -> dict:
    raise HTTPException(status_code=501, detail="AI analysis implemented in Lab PR 4")
