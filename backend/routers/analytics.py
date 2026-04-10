"""
Analytics API endpoints — Phase 3.

Computes equity curves and drawdown series from the PostgreSQL trades table,
and serves multi-strategy comparison aggregates.

GET /api/analytics/backtest/{run_id}/equity-curve  — cumulative PnL + drawdown series
GET /api/analytics/backtest/{run_id}/export-csv    — trades as CSV download
GET /api/analytics/strategies/compare             — rank strategies by best metrics
"""

import csv
import io
import logging
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse

from core.auth import TokenData, get_current_user
from core.db import get_pool

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
