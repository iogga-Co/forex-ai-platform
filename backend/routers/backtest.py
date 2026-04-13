"""
Backtest API endpoints — Phase 1 implementation.

POST /api/backtest                       — dispatch a Celery backtest job
GET  /api/backtest/jobs/{job_id}/status  — poll job status
GET  /api/backtest/results               — list past results (most recent first)
GET  /api/backtest/results/{result_id}   — fetch completed result with trades
"""

import logging
from typing import Annotated
from uuid import UUID

from celery.result import AsyncResult
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from core.auth import TokenData, get_current_user
from core.celery_app import celery_app
from core.db import get_pool
from tasks.backtest import run_backtest_task

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/backtest", tags=["Backtest"])


def _f(v: object) -> float | None:
    """Cast asyncpg Decimal/NUMERIC to float for JSON serialisation."""
    return float(v) if v is not None else None  # type: ignore[arg-type]


# ---------------------------------------------------------------------------
# Request / response models
# ---------------------------------------------------------------------------

class BacktestRequest(BaseModel):
    strategy_id: UUID
    period_start: str   # ISO date string e.g. "2020-01-01"
    period_end: str
    pair: str
    timeframe: str      # e.g. "1H", "1m"
    initial_capital: float = 100_000.0


class BacktestJobResponse(BaseModel):
    job_id: str
    status: str


class BacktestStatusResponse(BaseModel):
    job_id: str
    status: str         # "pending" | "running" | "complete" | "failed"
    progress_pct: int
    result_id: str | None = None
    error: str | None = None


# ---------------------------------------------------------------------------
# Routes — IMPORTANT: /jobs/ and /results/ routes declared before /{id}
# to avoid FastAPI path matching conflicts.
# ---------------------------------------------------------------------------

@router.post("", response_model=BacktestJobResponse, status_code=202)
async def run_backtest(
    payload: BacktestRequest,
    session_id: str = Query(
        ...,
        description=(
            "WebSocket session ID from the client.  "
            "Progress events are routed to this session."
        ),
    ),
    _: Annotated[TokenData | None, Depends(get_current_user)] = None,
) -> BacktestJobResponse:
    """
    Dispatch a backtest job to Celery.

    Returns immediately with a job_id.  Progress streams to the frontend via
    WebSocket (/ws/{session_id}).  Poll /api/backtest/jobs/{job_id}/status
    or listen on the WebSocket for the "complete" event.
    """
    task = run_backtest_task.apply_async(
        kwargs={
            "strategy_id": str(payload.strategy_id),
            "pair": payload.pair.upper().replace("/", ""),
            "timeframe": payload.timeframe,
            "period_start": payload.period_start,
            "period_end": payload.period_end,
            "session_id": session_id,
            "initial_capital": payload.initial_capital,
        }
    )
    logger.info(
        "Dispatched backtest job %s: strategy=%s %s %s %s→%s",
        task.id,
        payload.strategy_id,
        payload.pair,
        payload.timeframe,
        payload.period_start,
        payload.period_end,
    )
    return BacktestJobResponse(job_id=task.id, status="pending")


@router.get("/jobs/{job_id}/status", response_model=BacktestStatusResponse)
async def get_backtest_status(
    job_id: str,
    _: Annotated[TokenData | None, Depends(get_current_user)] = None,
) -> BacktestStatusResponse:
    """Poll the status of a dispatched backtest job."""
    result = AsyncResult(job_id, app=celery_app)

    celery_to_api = {
        "PENDING": "pending",
        "STARTED": "running",
        "SUCCESS": "complete",
        "FAILURE": "failed",
        "RETRY": "running",
        "REVOKED": "failed",
    }
    status = celery_to_api.get(result.state, "pending")

    result_id: str | None = None
    error: str | None = None
    progress_pct = 0

    if result.state == "SUCCESS" and isinstance(result.result, dict):
        result_id = result.result.get("result_id")
        progress_pct = 100

    if result.state == "FAILURE":
        error = str(result.result) if result.result else "Unknown error"
        progress_pct = 0

    return BacktestStatusResponse(
        job_id=job_id,
        status=status,
        progress_pct=progress_pct,
        result_id=result_id,
        error=error,
    )


@router.get("/results")
async def list_backtest_results(
    limit: int = Query(default=20, ge=1, le=100),
    strategy_id: UUID | None = Query(default=None),
    _: Annotated[TokenData | None, Depends(get_current_user)] = None,
) -> list[dict]:
    """
    List completed backtest runs, most recent first.
    Optionally filter by strategy_id.
    Returns summary rows (no trades) for the history view.
    """
    pool = await get_pool()
    async with pool.acquire() as conn:
        if strategy_id is not None:
            rows = await conn.fetch(
                """
                SELECT id, strategy_id, pair, timeframe,
                       period_start, period_end,
                       sharpe, max_dd, win_rate, trade_count, total_pnl,
                       created_at
                FROM backtest_runs
                WHERE strategy_id = $1
                ORDER BY created_at DESC
                LIMIT $2
                """,
                strategy_id,
                limit,
            )
        else:
            rows = await conn.fetch(
                """
                SELECT id, strategy_id, pair, timeframe,
                       period_start, period_end,
                       sharpe, max_dd, win_rate, trade_count, total_pnl,
                       created_at
                FROM backtest_runs
                ORDER BY created_at DESC
                LIMIT $1
                """,
                limit,
            )
    return [
        {
            "id": str(r["id"]),
            "strategy_id": str(r["strategy_id"]),
            "pair": r["pair"],
            "timeframe": r["timeframe"],
            "period_start": r["period_start"].isoformat(),
            "period_end": r["period_end"].isoformat(),
            "sharpe": _f(r["sharpe"]),
            "max_dd": _f(r["max_dd"]),
            "win_rate": _f(r["win_rate"]),
            "trade_count": r["trade_count"],
            "total_pnl": _f(r["total_pnl"]) or 0.0,
            "created_at": r["created_at"].isoformat(),
        }
        for r in rows
    ]


@router.delete("/results/{result_id}", status_code=204)
async def delete_backtest_result(
    result_id: UUID,
    _: Annotated[TokenData | None, Depends(get_current_user)] = None,
) -> None:
    """Delete a single backtest run. Trades are removed via ON DELETE CASCADE."""
    pool = await get_pool()
    async with pool.acquire() as conn:
        result = await conn.execute(
            "DELETE FROM backtest_runs WHERE id = $1", result_id
        )
    if result == "DELETE 0":
        raise HTTPException(status_code=404, detail="Backtest result not found")
    logger.info("Deleted backtest run %s", result_id)


@router.get("/results/{result_id}")
async def get_backtest_result(
    result_id: UUID,
    _: Annotated[TokenData | None, Depends(get_current_user)] = None,
) -> dict:
    """
    Retrieve a completed backtest result including metrics and all trades.
    """
    pool = await get_pool()
    async with pool.acquire() as conn:
        run = await conn.fetchrow(
            """
            SELECT id, strategy_id, period_start, period_end, pair, timeframe,
                   sharpe, sortino, max_dd, win_rate, avg_r, trade_count, total_pnl,
                   created_at
            FROM backtest_runs WHERE id = $1
            """,
            result_id,
        )
        if run is None:
            raise HTTPException(status_code=404, detail="Backtest result not found")

        trades = await conn.fetch(
            """
            SELECT id, entry_time, exit_time, direction,
                   entry_price, exit_price, pnl, r_multiple, mae, mfe, signal_context
            FROM trades WHERE backtest_run_id = $1
            ORDER BY entry_time ASC
            """,
            result_id,
        )

    return {
        "id": str(run["id"]),
        "strategy_id": str(run["strategy_id"]),
        "period_start": run["period_start"].isoformat(),
        "period_end": run["period_end"].isoformat(),
        "pair": run["pair"],
        "timeframe": run["timeframe"],
        "metrics": {
            "sharpe": _f(run["sharpe"]),
            "sortino": _f(run["sortino"]),
            "max_dd": _f(run["max_dd"]),
            "win_rate": _f(run["win_rate"]),
            "avg_r": _f(run["avg_r"]),
            "trade_count": run["trade_count"],
            "total_pnl": _f(run["total_pnl"]),
        },
        "created_at": run["created_at"].isoformat(),
        "trades": [
            {
                "id": str(t["id"]),
                "entry_time": t["entry_time"].isoformat(),
                "exit_time": t["exit_time"].isoformat(),
                "direction": t["direction"],
                "entry_price": float(t["entry_price"]),
                "exit_price": float(t["exit_price"]),
                "pnl": float(t["pnl"]),
                "r_multiple": float(t["r_multiple"]),
                "mae": float(t["mae"]),
                "mfe": float(t["mfe"]),
                "signal_context": t["signal_context"],
            }
            for t in trades
        ],
    }
