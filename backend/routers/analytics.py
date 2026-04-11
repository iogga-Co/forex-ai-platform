"""
Analytics API endpoints — Phase 3.

Computes equity curves and drawdown series from the PostgreSQL trades table,
and serves multi-strategy comparison aggregates.

GET /api/analytics/backtest/{run_id}/equity-curve  — cumulative PnL + drawdown series
GET /api/analytics/backtest/{run_id}/export-csv    — trades as CSV download
GET /api/analytics/backtest/{run_id}/candles       — 1H OHLCV for the backtest period
GET /api/analytics/backtest/{run_id}/indicators    — computed indicator series from strategy IR
GET /api/analytics/strategies/compare             — rank strategies by best metrics
"""

import csv
import io
import logging
from typing import Annotated
from uuid import UUID

import numpy as np
import pandas as pd
from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse

from core.auth import TokenData, get_current_user
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

router = APIRouter(prefix="/api/analytics", tags=["Analytics"])


@router.get("/backtest/{run_id}/equity-curve")
async def equity_curve(
    run_id: UUID,
    _: Annotated[TokenData | None, Depends(get_current_user)] = None,
) -> dict:
    """
    Cumulative PnL and drawdown series derived from the trades table.

    Returns a list of data points ordered by trade entry time.  Each point
    carries the running equity, cumulative PnL, and drawdown fraction so the
    frontend can render both the equity curve and drawdown chart from a single
    request.
    """
    pool = await get_pool()
    async with pool.acquire() as conn:
        exists = await conn.fetchval(
            "SELECT 1 FROM backtest_runs WHERE id = $1", run_id
        )
        if not exists:
            raise HTTPException(status_code=404, detail="Backtest result not found")

        rows = await conn.fetch(
            """
            WITH cumulative AS (
                SELECT
                    entry_time,
                    SUM(pnl) OVER (
                        ORDER BY entry_time
                        ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
                    ) AS cumulative_pnl
                FROM trades
                WHERE backtest_run_id = $1
            )
            SELECT
                entry_time,
                cumulative_pnl,
                MAX(cumulative_pnl) OVER (
                    ORDER BY entry_time
                    ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
                ) AS running_peak_pnl
            FROM cumulative
            ORDER BY entry_time
            """,
            run_id,
        )

    initial_capital = 100_000.0
    points = []

    for r in rows:
        cum_pnl = float(r["cumulative_pnl"])
        equity = initial_capital + cum_pnl
        peak = initial_capital + float(r["running_peak_pnl"])
        drawdown = (equity - peak) / peak if peak > 0 else 0.0
        points.append({
            "time": r["entry_time"].isoformat(),
            "equity": round(equity, 2),
            "cumulative_pnl": round(cum_pnl, 2),
            "drawdown": round(drawdown, 4),
        })

    final_cumulative = float(rows[-1]["cumulative_pnl"]) if rows else 0.0
    return {
        "run_id": str(run_id),
        "initial_capital": initial_capital,
        "final_equity": round(initial_capital + final_cumulative, 2),
        "max_drawdown": round(min((p["drawdown"] for p in points), default=0.0), 4),
        "points": points,
    }


@router.get("/backtest/{run_id}/export-csv")
async def export_trades_csv(
    run_id: UUID,
    _: Annotated[TokenData | None, Depends(get_current_user)] = None,
) -> StreamingResponse:
    """Export all trades for a backtest run as a CSV file."""
    pool = await get_pool()
    async with pool.acquire() as conn:
        exists = await conn.fetchval(
            "SELECT 1 FROM backtest_runs WHERE id = $1", run_id
        )
        if not exists:
            raise HTTPException(status_code=404, detail="Backtest result not found")

        trades = await conn.fetch(
            """
            SELECT entry_time, exit_time, direction,
                   entry_price, exit_price, pnl, r_multiple, mae, mfe
            FROM trades
            WHERE backtest_run_id = $1
            ORDER BY entry_time ASC
            """,
            run_id,
        )

    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow([
        "entry_time", "exit_time", "direction",
        "entry_price", "exit_price", "pnl", "r_multiple", "mae", "mfe",
    ])
    for t in trades:
        writer.writerow([
            t["entry_time"].isoformat(),
            t["exit_time"].isoformat(),
            t["direction"],
            float(t["entry_price"]),
            float(t["exit_price"]),
            float(t["pnl"]),
            float(t["r_multiple"]),
            float(t["mae"]),
            float(t["mfe"]),
        ])

    output.seek(0)
    return StreamingResponse(
        iter([output.getvalue()]),
        media_type="text/csv",
        headers={
            "Content-Disposition": f"attachment; filename=backtest_{run_id}_trades.csv"
        },
    )


@router.get("/backtest/{run_id}/candles")
async def get_backtest_candles(
    run_id: UUID,
    _: Annotated[TokenData | None, Depends(get_current_user)] = None,
) -> dict:
    """
    Return OHLCV candles for the pair/period of a backtest run.

    Always serves 1H candles regardless of the backtest timeframe — this keeps
    the dataset manageable (≤ ~17 500 bars for a 2-year window) while giving
    enough resolution to see trade context.  Trade markers are placed at their
    exact entry/exit timestamps via the nearest 1H bar.
    """
    pool = await get_pool()
    async with pool.acquire() as conn:
        run = await conn.fetchrow(
            "SELECT pair, period_start, period_end FROM backtest_runs WHERE id = $1",
            run_id,
        )
        if run is None:
            raise HTTPException(status_code=404, detail="Backtest result not found")

        candles = await conn.fetch(
            """
            SELECT timestamp, open, high, low, close
            FROM ohlcv_candles
            WHERE pair = $1 AND timeframe = '1H'
              AND timestamp >= $2 AND timestamp <= $3
            ORDER BY timestamp ASC
            """,
            run["pair"],
            run["period_start"],
            run["period_end"],
        )

    return {
        "pair": run["pair"],
        "timeframe": "1H",
        "candles": [
            {
                "time": int(c["timestamp"].timestamp()),
                "open": float(c["open"]),
                "high": float(c["high"]),
                "low": float(c["low"]),
                "close": float(c["close"]),
            }
            for c in candles
        ],
    }


@router.get("/backtest/{run_id}/indicators")
async def get_backtest_indicators(
    run_id: UUID,
    _: Annotated[TokenData | None, Depends(get_current_user)] = None,
) -> dict:
    """
    Compute indicator series for all indicators referenced in the strategy's IR.

    Fetches 1H OHLCV data with a 300-bar warmup window so indicator values at
    period_start are fully primed.  Only data points from period_start onward
    are returned.

    Returns:
        indicators: list of indicator groups, each with:
            id      — unique key (e.g. "EMA_20", "RSI_14")
            type    — indicator name
            pane    — "overlay" (price chart) or "oscillator" (separate pane)
            levels  — optional horizontal reference lines
            series  — list of {name, color, data: [{time, value}]}
    """
    pool = await get_pool()
    async with pool.acquire() as conn:
        run = await conn.fetchrow(
            """
            SELECT br.pair, br.period_start, br.period_end, s.ir_json
            FROM backtest_runs br
            JOIN strategies s ON s.id = br.strategy_id
            WHERE br.id = $1
            """,
            run_id,
        )
        if run is None:
            raise HTTPException(status_code=404, detail="Backtest result not found")

        ir = run["ir_json"] or {}
        if not ir:
            return {"indicators": []}

        candle_rows = await conn.fetch(
            """
            SELECT timestamp, open, high, low, close
            FROM ohlcv_candles
            WHERE pair = $1 AND timeframe = '1H'
              AND timestamp >= ($2::timestamptz - INTERVAL '300 hours')
              AND timestamp <= $3
            ORDER BY timestamp ASC
            """,
            run["pair"],
            run["period_start"],
            run["period_end"],
        )

    if not candle_rows:
        return {"indicators": []}

    # Build DataFrame with UTC-aware index
    df = pd.DataFrame(
        {
            "open": [float(r["open"]) for r in candle_rows],
            "high": [float(r["high"]) for r in candle_rows],
            "low": [float(r["low"]) for r in candle_rows],
            "close": [float(r["close"]) for r in candle_rows],
        },
        index=pd.DatetimeIndex([r["timestamp"] for r in candle_rows]),
    )

    # Collect unique indicator specs from entry_conditions
    entry_conditions = ir.get("entry_conditions", []) or []
    exit_conditions = ir.get("exit_conditions", {}) or {}

    specs: dict[str, dict] = {}

    for cond in entry_conditions:
        ind = str(cond.get("indicator", "")).upper()
        if ind == "EMA":
            p = int(cond.get("period") or 14)
            specs.setdefault(f"EMA_{p}", {"type": "EMA", "period": p})
        elif ind == "SMA":
            p = int(cond.get("period") or 14)
            specs.setdefault(f"SMA_{p}", {"type": "SMA", "period": p})
        elif ind == "RSI":
            p = int(cond.get("period") or 14)
            specs.setdefault(f"RSI_{p}", {"type": "RSI", "period": p})
        elif ind == "MACD":
            fast = int(cond.get("fast") or 12)
            slow_ = int(cond.get("slow") or 26)
            sig = int(cond.get("signal_period") or 9)
            specs.setdefault(f"MACD_{fast}_{slow_}_{sig}", {"type": "MACD", "fast": fast, "slow": slow_, "signal_period": sig})
        elif ind == "BB":
            p = int(cond.get("period") or 20)
            std = float(cond.get("std_dev") or 2.0)
            specs.setdefault(f"BB_{p}_{std}", {"type": "BB", "period": p, "std_dev": std})
        elif ind == "ATR":
            p = int(cond.get("period") or 14)
            specs.setdefault(f"ATR_{p}", {"type": "ATR", "period": p})
        elif ind == "ADX":
            p = int(cond.get("period") or 14)
            specs.setdefault(f"ADX_{p}", {"type": "ADX", "period": p})
        elif ind == "STOCH":
            p = int(cond.get("period") or 14)
            ks = int(cond.get("k_smooth") or 3)
            dp = int(cond.get("d_period") or 3)
            specs.setdefault(f"STOCH_{p}_{ks}_{dp}", {"type": "STOCH", "period": p, "k_smooth": ks, "d_period": dp})

    # Also pick up ATR from stop_loss / take_profit exit conditions
    for side in ("stop_loss", "take_profit"):
        ec = exit_conditions.get(side, {})
        if isinstance(ec, dict) and str(ec.get("type", "")).upper() == "ATR":
            p = int(ec.get("period") or 14)
            specs.setdefault(f"ATR_{p}", {"type": "ATR", "period": p})

    if not specs:
        return {"indicators": []}

    period_start = run["period_start"]

    def to_points(series: "pd.Series") -> list[dict]:
        """Trim to period_start, drop NaN, convert to {time, value} dicts."""
        trimmed = series[series.index >= period_start]
        out = []
        for ts, v in trimmed.items():
            if pd.notna(v) and np.isfinite(float(v)):
                out.append({"time": int(ts.timestamp()), "value": round(float(v), 6)})
        return out

    # Color palette
    COLORS = {
        "EMA": "#f59e0b",
        "SMA": "#38bdf8",
        "BB_band": "#6366f1",
        "BB_mid": "#8b5cf6",
        "RSI": "#a78bfa",
        "MACD_line": "#3b82f6",
        "MACD_signal": "#f97316",
        "ATR": "#22d3ee",
        "ADX": "#eab308",
        "STOCH_k": "#ec4899",
        "STOCH_d": "#f43f5e",
    }

    result_indicators = []

    for key, spec in specs.items():
        t = spec["type"]

        if t == "EMA":
            s = calc_ema(df["close"], spec["period"])
            result_indicators.append({
                "id": key, "type": "EMA", "pane": "overlay",
                "series": [{"name": f"EMA {spec['period']}", "color": COLORS["EMA"], "data": to_points(s)}],
            })

        elif t == "SMA":
            s = calc_sma(df["close"], spec["period"])
            result_indicators.append({
                "id": key, "type": "SMA", "pane": "overlay",
                "series": [{"name": f"SMA {spec['period']}", "color": COLORS["SMA"], "data": to_points(s)}],
            })

        elif t == "BB":
            upper, middle, lower = calc_bb(df["close"], spec["period"], spec["std_dev"])
            result_indicators.append({
                "id": key, "type": "BB", "pane": "overlay",
                "series": [
                    {"name": f"BB Upper", "color": COLORS["BB_band"], "data": to_points(upper)},
                    {"name": f"BB Middle", "color": COLORS["BB_mid"], "data": to_points(middle)},
                    {"name": f"BB Lower", "color": COLORS["BB_band"], "data": to_points(lower)},
                ],
            })

        elif t == "RSI":
            s = calc_rsi(df["close"], spec["period"])
            result_indicators.append({
                "id": key, "type": "RSI", "pane": "oscillator",
                "levels": [
                    {"value": 70, "color": "#6b7280"},
                    {"value": 50, "color": "#374151"},
                    {"value": 30, "color": "#6b7280"},
                ],
                "series": [{"name": f"RSI {spec['period']}", "color": COLORS["RSI"], "data": to_points(s)}],
            })

        elif t == "MACD":
            macd_line, signal_line, _ = calc_macd(df["close"], spec["fast"], spec["slow"], spec["signal_period"])
            result_indicators.append({
                "id": key, "type": "MACD", "pane": "oscillator",
                "levels": [{"value": 0, "color": "#374151"}],
                "series": [
                    {"name": "MACD", "color": COLORS["MACD_line"], "data": to_points(macd_line)},
                    {"name": "Signal", "color": COLORS["MACD_signal"], "data": to_points(signal_line)},
                ],
            })

        elif t == "ATR":
            s = calc_atr(df["high"], df["low"], df["close"], spec["period"])
            result_indicators.append({
                "id": key, "type": "ATR", "pane": "oscillator",
                "series": [{"name": f"ATR {spec['period']}", "color": COLORS["ATR"], "data": to_points(s)}],
            })

        elif t == "ADX":
            s = calc_adx(df["high"], df["low"], df["close"], spec["period"])
            result_indicators.append({
                "id": key, "type": "ADX", "pane": "oscillator",
                "levels": [{"value": 25, "color": "#6b7280"}],
                "series": [{"name": f"ADX {spec['period']}", "color": COLORS["ADX"], "data": to_points(s)}],
            })

        elif t == "STOCH":
            k, d = calc_stoch(df["high"], df["low"], df["close"], spec["period"], spec["k_smooth"], spec["d_period"])
            result_indicators.append({
                "id": key, "type": "STOCH", "pane": "oscillator",
                "levels": [
                    {"value": 80, "color": "#6b7280"},
                    {"value": 20, "color": "#6b7280"},
                ],
                "series": [
                    {"name": "%K", "color": COLORS["STOCH_k"], "data": to_points(k)},
                    {"name": "%D", "color": COLORS["STOCH_d"], "data": to_points(d)},
                ],
            })

    return {"indicators": result_indicators}


@router.get("/strategies/compare")
async def compare_strategies(
    ids: str = Query(..., description="Comma-separated strategy UUIDs (max 10)"),
    _: Annotated[TokenData | None, Depends(get_current_user)] = None,
) -> dict:
    """
    Compare multiple strategies by aggregating their backtest results.
    Returns the best Sharpe, lowest drawdown, and run count for each strategy,
    ranked by best Sharpe descending.
    """
    strategy_ids = [s.strip() for s in ids.split(",") if s.strip()]
    if not strategy_ids or len(strategy_ids) > 10:
        raise HTTPException(
            status_code=400, detail="Provide between 1 and 10 strategy IDs"
        )

    pool = await get_pool()
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT
                strategy_id,
                COUNT(*)                    AS run_count,
                MAX(sharpe)                 AS best_sharpe,
                MIN(max_dd)                 AS best_max_dd,
                MAX(win_rate)               AS best_win_rate,
                MAX(total_pnl)              AS best_total_pnl,
                AVG(sharpe)                 AS avg_sharpe,
                SUM(trade_count)            AS total_trades
            FROM backtest_runs
            WHERE strategy_id = ANY($1::uuid[])
            GROUP BY strategy_id
            ORDER BY best_sharpe DESC NULLS LAST
            """,
            strategy_ids,
        )

    def _f(v: object) -> float | None:
        return float(v) if v is not None else None  # type: ignore[arg-type]

    return {
        "strategies": [
            {
                "strategy_id": str(r["strategy_id"]),
                "run_count": r["run_count"],
                "best_sharpe": _f(r["best_sharpe"]),
                "best_max_dd": _f(r["best_max_dd"]),
                "best_win_rate": _f(r["best_win_rate"]),
                "best_total_pnl": _f(r["best_total_pnl"]),
                "avg_sharpe": _f(r["avg_sharpe"]),
                "total_trades": r["total_trades"],
            }
            for r in rows
        ]
    }
