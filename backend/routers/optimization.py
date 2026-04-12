"""
Optimization API endpoints.

POST   /api/optimization/runs                   — create a new run (status=pending)
GET    /api/optimization/runs                   — list runs for current user
GET    /api/optimization/runs/{run_id}          — get run details + best result
POST   /api/optimization/runs/{run_id}/start    — enqueue the Celery task
POST   /api/optimization/runs/{run_id}/stop     — set Redis stop-signal
GET    /api/optimization/runs/{run_id}/stream   — SSE live progress stream
GET    /api/optimization/runs/{run_id}/iterations — list all iterations
"""

import asyncio
import json
import logging
from datetime import date
from typing import Annotated
from uuid import UUID

import redis.asyncio as aioredis
from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from core.auth import TokenData, get_current_user, get_current_user_sse
from core.config import settings
from core.db import get_pool
from tasks.optimization import run_optimization_task

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/optimization", tags=["Optimization"])

_STOP_KEY = "opt:stop:{run_id}"
_SSE_CHANNEL = "opt:progress:{run_id}"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _f(v: object) -> float | None:
    return float(v) if v is not None else None  # type: ignore[arg-type]


def _sse(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data)}\n\n"


# ---------------------------------------------------------------------------
# Request / Response models
# ---------------------------------------------------------------------------

class CreateRunRequest(BaseModel):
    strategy_id: UUID
    pair: str
    timeframe: str
    period_start: str       # ISO date "2020-01-01"
    period_end: str
    system_prompt: str = ""
    user_prompt: str = ""
    max_iterations: int = 20
    time_limit_minutes: int = 60
    target_win_rate: float | None = None
    target_sharpe: float | None = None


class RunResponse(BaseModel):
    id: str
    status: str
    pair: str
    timeframe: str
    period_start: str
    period_end: str
    max_iterations: int
    current_iteration: int
    best_sharpe: float | None
    best_win_rate: float | None
    best_iteration: int | None
    best_strategy_id: str | None
    stop_reason: str | None
    created_at: str


# ---------------------------------------------------------------------------
# POST /api/optimization/runs  — create
# ---------------------------------------------------------------------------

@router.post("/runs", response_model=RunResponse, status_code=201)
async def create_run(
    payload: CreateRunRequest,
    user: Annotated[TokenData, Depends(get_current_user)],
    pool=Depends(get_pool),
):
    async with pool.acquire() as conn:
        # Verify strategy exists
        row = await conn.fetchrow(
            "SELECT id FROM strategies WHERE id = $1", str(payload.strategy_id)
        )
        if row is None:
            raise HTTPException(status_code=404, detail="Strategy not found")

        run = await conn.fetchrow(
            """
            INSERT INTO optimization_runs (
                user_id, pair, timeframe, period_start, period_end,
                initial_strategy_id, system_prompt, user_prompt,
                max_iterations, time_limit_minutes,
                target_win_rate, target_sharpe
            )
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
            RETURNING
                id, status, pair, timeframe,
                period_start, period_end,
                max_iterations, current_iteration,
                best_sharpe, best_win_rate, best_iteration, best_strategy_id,
                stop_reason, created_at
            """,
            user.sub,
            payload.pair,
            payload.timeframe,
            date.fromisoformat(payload.period_start),
            date.fromisoformat(payload.period_end),
            str(payload.strategy_id),
            payload.system_prompt,
            payload.user_prompt,
            payload.max_iterations,
            payload.time_limit_minutes,
            payload.target_win_rate,
            payload.target_sharpe,
        )

    return _row_to_run(run)


# ---------------------------------------------------------------------------
# GET /api/optimization/runs  — list
# ---------------------------------------------------------------------------

@router.get("/runs", response_model=list[RunResponse])
async def list_runs(
    user: Annotated[TokenData, Depends(get_current_user)],
    pool=Depends(get_pool),
    limit: int = Query(20, ge=1, le=100),
    offset: int = Query(0, ge=0),
):
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT id, status, pair, timeframe,
                   period_start, period_end,
                   max_iterations, current_iteration,
                   best_sharpe, best_win_rate, best_iteration, best_strategy_id,
                   stop_reason, created_at
            FROM optimization_runs
            WHERE user_id = $1
            ORDER BY created_at DESC
            LIMIT $2 OFFSET $3
            """,
            user.sub,
            limit,
            offset,
        )
    return [_row_to_run(r) for r in rows]


# ---------------------------------------------------------------------------
# GET /api/optimization/runs/{run_id}  — detail
# ---------------------------------------------------------------------------

@router.get("/runs/{run_id}", response_model=RunResponse)
async def get_run(
    run_id: UUID,
    user: Annotated[TokenData, Depends(get_current_user)],
    pool=Depends(get_pool),
):
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            SELECT id, status, pair, timeframe,
                   period_start, period_end,
                   max_iterations, current_iteration,
                   best_sharpe, best_win_rate, best_iteration, best_strategy_id,
                   stop_reason, created_at
            FROM optimization_runs
            WHERE id = $1 AND user_id = $2
            """,
            str(run_id),
            user.sub,
        )
    if row is None:
        raise HTTPException(status_code=404, detail="Optimization run not found")
    return _row_to_run(row)


# ---------------------------------------------------------------------------
# POST /api/optimization/runs/{run_id}/start  — enqueue
# ---------------------------------------------------------------------------

@router.post("/runs/{run_id}/start")
async def start_run(
    run_id: UUID,
    user: Annotated[TokenData, Depends(get_current_user)],
    pool=Depends(get_pool),
):
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT status FROM optimization_runs WHERE id = $1 AND user_id = $2",
            str(run_id),
            user.sub,
        )
    if row is None:
        raise HTTPException(status_code=404, detail="Optimization run not found")
    if row["status"] not in ("pending", "failed"):
        raise HTTPException(
            status_code=409,
            detail=f"Run is already {row['status']} — cannot start",
        )

    task = run_optimization_task.apply_async(
        args=[str(run_id)],
        queue="optimization",
    )
    logger.info("Enqueued optimization run %s as Celery task %s", run_id, task.id)
    return {"run_id": str(run_id), "celery_task_id": task.id, "status": "running"}


# ---------------------------------------------------------------------------
# POST /api/optimization/runs/{run_id}/stop  — cooperative stop
# ---------------------------------------------------------------------------

@router.post("/runs/{run_id}/stop")
async def stop_run(
    run_id: UUID,
    user: Annotated[TokenData, Depends(get_current_user)],
    pool=Depends(get_pool),
):
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT status FROM optimization_runs WHERE id = $1 AND user_id = $2",
            str(run_id),
            user.sub,
        )
    if row is None:
        raise HTTPException(status_code=404, detail="Optimization run not found")
    if row["status"] != "running":
        raise HTTPException(
            status_code=409,
            detail=f"Run is {row['status']}, not running",
        )

    r = await aioredis.from_url(settings.redis_url, decode_responses=True)
    try:
        await r.set(_STOP_KEY.format(run_id=str(run_id)), "1", ex=3600)
    finally:
        await r.aclose()

    logger.info("Stop signal set for optimization run %s", run_id)
    return {"run_id": str(run_id), "msg": "Stop signal sent"}


# ---------------------------------------------------------------------------
# GET /api/optimization/runs/{run_id}/stream  — SSE
# ---------------------------------------------------------------------------

@router.get("/runs/{run_id}/stream")
async def stream_run(
    run_id: UUID,
    user: Annotated[TokenData, Depends(get_current_user_sse)],
    pool=Depends(get_pool),
):
    """
    Server-Sent Events stream for live optimization progress.
    Subscribes to Redis channel opt:progress:{run_id} and forwards events.
    Terminates automatically when a 'complete' or 'error' event arrives,
    or when the client disconnects.
    """
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT status FROM optimization_runs WHERE id = $1 AND user_id = $2",
            str(run_id),
            user.sub,
        )
    if row is None:
        raise HTTPException(status_code=404, detail="Optimization run not found")

    channel = _SSE_CHANNEL.format(run_id=str(run_id))

    async def event_generator():
        r = await aioredis.from_url(settings.redis_url, decode_responses=True)
        pubsub = r.pubsub()
        try:
            await pubsub.subscribe(channel)
            async for message in pubsub.listen():
                if message["type"] != "message":
                    continue
                try:
                    data = json.loads(message["data"])
                    event = data.get("event", "progress")
                    yield _sse(event, data)
                    if event in ("complete", "error"):
                        break
                except Exception as exc:
                    logger.warning("SSE parse error for run %s: %s", run_id, exc)
        except asyncio.CancelledError:
            pass
        finally:
            try:
                await pubsub.unsubscribe(channel)
            except Exception:
                pass
            await r.aclose()

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


# ---------------------------------------------------------------------------
# GET /api/optimization/runs/{run_id}/iterations  — iteration list
# ---------------------------------------------------------------------------

@router.get("/runs/{run_id}/iterations")
async def list_iterations(
    run_id: UUID,
    user: Annotated[TokenData, Depends(get_current_user)],
    pool=Depends(get_pool),
):
    async with pool.acquire() as conn:
        # Verify ownership
        owner = await conn.fetchval(
            "SELECT user_id FROM optimization_runs WHERE id = $1", str(run_id)
        )
        if owner is None:
            raise HTTPException(status_code=404, detail="Optimization run not found")
        if str(owner) != user.sub:
            raise HTTPException(status_code=403, detail="Forbidden")

        rows = await conn.fetch(
            """
            SELECT iteration_number, sharpe, win_rate, max_dd, total_pnl,
                   trade_count, ai_analysis, ai_changes, created_at
            FROM optimization_iterations
            WHERE run_id = $1
            ORDER BY iteration_number
            """,
            str(run_id),
        )

    return [
        {
            "iteration": r["iteration_number"],
            "sharpe": _f(r["sharpe"]),
            "win_rate": _f(r["win_rate"]),
            "max_dd": _f(r["max_dd"]),
            "total_pnl": _f(r["total_pnl"]),
            "trade_count": r["trade_count"],
            "ai_analysis": r["ai_analysis"],
            "ai_changes": r["ai_changes"],
            "created_at": r["created_at"].isoformat(),
        }
        for r in rows
    ]


# ---------------------------------------------------------------------------
# Internal helper
# ---------------------------------------------------------------------------

def _row_to_run(row) -> RunResponse:
    return RunResponse(
        id=str(row["id"]),
        status=row["status"],
        pair=row["pair"],
        timeframe=row["timeframe"],
        period_start=row["period_start"].isoformat() if hasattr(row["period_start"], "isoformat") else str(row["period_start"]),
        period_end=row["period_end"].isoformat() if hasattr(row["period_end"], "isoformat") else str(row["period_end"]),
        max_iterations=row["max_iterations"],
        current_iteration=row["current_iteration"],
        best_sharpe=_f(row["best_sharpe"]),
        best_win_rate=_f(row["best_win_rate"]),
        best_iteration=row["best_iteration"],
        best_strategy_id=str(row["best_strategy_id"]) if row["best_strategy_id"] else None,
        stop_reason=row["stop_reason"],
        created_at=row["created_at"].isoformat(),
    )
