"""
G-Optimize API endpoints.

POST   /api/g-optimize/runs                         — create a new run (status=pending)
GET    /api/g-optimize/runs                         — list all runs for current user
GET    /api/g-optimize/runs/{run_id}                — run detail + progress counts
DELETE /api/g-optimize/runs/{run_id}                — delete run (blocked if running)
GET    /api/g-optimize/runs/{run_id}/stream         — SSE live progress (stub)
POST   /api/g-optimize/runs/{run_id}/stop           — cooperative stop (stub)
GET    /api/g-optimize/runs/{run_id}/strategies     — strategies for a run (stub)
POST   /api/g-optimize/strategies/{backtest_id}/promote — promote to RAG (stub)
POST   /api/g-optimize/analyze                      — Co-Pilot ranking (stub)
"""

import asyncio
import json
import logging
from datetime import date
from typing import Annotated
from uuid import UUID

import redis as sync_redis
import redis.asyncio as aioredis
from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from core.auth import TokenData, get_current_user, get_current_user_sse
from core.config import settings
from core.db import get_pool
from tasks.g_optimize import run_g_optimize

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/g-optimize", tags=["G-Optimize"])

_NOT_IMPLEMENTED  = {"status": "not_implemented"}
_STOP_KEY         = "g_optimize:stop:{run_id}"
_STOP_KEY_TTL     = 3600  # 1 hour
_SSE_CHANNEL      = "g_optimize:progress:{run_id}"

def _get_redis() -> sync_redis.Redis:
    return sync_redis.Redis.from_url(settings.redis_url, decode_responses=True)

def _sse(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data)}\n\n"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _f(v: object) -> float | None:
    return float(v) if v is not None else None  # type: ignore[arg-type]


def _iso(v: object) -> str | None:
    if v is None:
        return None
    return v.isoformat() if hasattr(v, "isoformat") else str(v)


def _row_to_run(row) -> "GOptimizeRunResponse":
    return GOptimizeRunResponse(
        id=str(row["id"]),
        status=row["status"],
        pairs=list(row["pairs"]),
        timeframe=row["timeframe"],
        period_start=_iso(row["period_start"]),
        period_end=_iso(row["period_end"]),
        n_configs=row["n_configs"],
        store_trades=row["store_trades"],
        entry_config=dict(row["entry_config"]) if row["entry_config"] else {},
        exit_config=dict(row["exit_config"]) if row["exit_config"] else {},
        threshold_sharpe=_f(row["threshold_sharpe"]),
        threshold_win_rate=_f(row["threshold_win_rate"]),
        threshold_max_dd=_f(row["threshold_max_dd"]),
        threshold_min_trades=row["threshold_min_trades"],
        auto_rag=row["auto_rag"],
        configs_total=row["configs_total"],
        configs_done=row["configs_done"],
        configs_passed=row["configs_passed"],
        configs_failed=row["configs_failed"],
        error_message=row["error_message"],
        started_at=_iso(row["started_at"]),
        completed_at=_iso(row["completed_at"]),
        created_at=_iso(row["created_at"]),
    )


# ---------------------------------------------------------------------------
# Request / Response models
# ---------------------------------------------------------------------------

class CreateRunRequest(BaseModel):
    pairs: list[str] = Field(min_length=1)
    timeframe: str = "1H"
    period_start: str
    period_end: str
    n_configs: int = Field(ge=100)
    store_trades: str = "passing"  # 'passing' | 'all' | 'none'
    entry_config: dict
    exit_config: dict
    threshold_sharpe: float = 0.8
    threshold_win_rate: float = 45.0
    threshold_max_dd: float = 15.0
    threshold_min_trades: int = 30
    auto_rag: bool = True


class GOptimizeRunResponse(BaseModel):
    id: str
    status: str
    pairs: list[str]
    timeframe: str
    period_start: str | None
    period_end: str | None
    n_configs: int
    store_trades: str
    entry_config: dict
    exit_config: dict
    threshold_sharpe: float | None
    threshold_win_rate: float | None
    threshold_max_dd: float | None
    threshold_min_trades: int
    auto_rag: bool
    configs_total: int
    configs_done: int
    configs_passed: int
    configs_failed: int
    error_message: str | None
    started_at: str | None
    completed_at: str | None
    created_at: str | None


# ---------------------------------------------------------------------------
# POST /api/g-optimize/runs  — create
# ---------------------------------------------------------------------------

@router.post("/runs", response_model=GOptimizeRunResponse, status_code=201)
async def create_run(
    payload: CreateRunRequest,
    user: Annotated[TokenData, Depends(get_current_user)],
    pool=Depends(get_pool),
):
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            INSERT INTO g_optimize_runs (
                user_id, pairs, timeframe, period_start, period_end,
                n_configs, store_trades, entry_config, exit_config,
                threshold_sharpe, threshold_win_rate, threshold_max_dd,
                threshold_min_trades, auto_rag
            )
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
            RETURNING *
            """,
            user.sub,
            payload.pairs,
            payload.timeframe,
            date.fromisoformat(payload.period_start),
            date.fromisoformat(payload.period_end),
            payload.n_configs,
            payload.store_trades,
            payload.entry_config,
            payload.exit_config,
            payload.threshold_sharpe,
            payload.threshold_win_rate,
            payload.threshold_max_dd,
            payload.threshold_min_trades,
            payload.auto_rag,
        )

    run_id = str(row["id"])
    task = run_g_optimize.apply_async(args=[run_id], queue="g_optimize")
    logger.info("Enqueued G-Optimize run %s as Celery task %s", run_id, task.id)
    return _row_to_run(row)


# ---------------------------------------------------------------------------
# GET /api/g-optimize/runs  — list
# ---------------------------------------------------------------------------

@router.get("/runs", response_model=list[GOptimizeRunResponse])
async def list_runs(
    user: Annotated[TokenData, Depends(get_current_user)],
    pool=Depends(get_pool),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
):
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT *
            FROM g_optimize_runs
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
# GET /api/g-optimize/runs/{run_id}  — detail
# ---------------------------------------------------------------------------

@router.get("/runs/{run_id}", response_model=GOptimizeRunResponse)
async def get_run(
    run_id: UUID,
    user: Annotated[TokenData, Depends(get_current_user)],
    pool=Depends(get_pool),
):
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT * FROM g_optimize_runs WHERE id = $1 AND user_id = $2",
            str(run_id),
            user.sub,
        )
    if row is None:
        raise HTTPException(status_code=404, detail="G-Optimize run not found")
    return _row_to_run(row)


# ---------------------------------------------------------------------------
# DELETE /api/g-optimize/runs/{run_id}  — delete (blocked if running)
# ---------------------------------------------------------------------------

@router.delete("/runs/{run_id}", status_code=204)
async def delete_run(
    run_id: UUID,
    user: Annotated[TokenData, Depends(get_current_user)],
    pool=Depends(get_pool),
):
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT status FROM g_optimize_runs WHERE id = $1 AND user_id = $2",
            str(run_id),
            user.sub,
        )
        if row is None:
            raise HTTPException(status_code=404, detail="G-Optimize run not found")
        if row["status"] == "running":
            raise HTTPException(
                status_code=409,
                detail="Cannot delete a run that is currently running — stop it first",
            )
        # Delete backtest_runs first (cascades to trades); strategies are kept in RAG corpus
        await conn.execute(
            "DELETE FROM backtest_runs WHERE g_optimize_run_id = $1",
            str(run_id),
        )
        await conn.execute(
            "DELETE FROM g_optimize_runs WHERE id = $1",
            str(run_id),
        )


# ---------------------------------------------------------------------------
# Stub endpoints — implemented in later PRs
# ---------------------------------------------------------------------------

@router.get("/runs/{run_id}/stream")
async def stream_run_progress(
    run_id: UUID,
    user: Annotated[TokenData, Depends(get_current_user_sse)],
    pool=Depends(get_pool),
):
    """SSE stream for live G-Optimize progress. Terminates on done/error event."""
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT status FROM g_optimize_runs WHERE id = $1 AND user_id = $2",
            str(run_id), user.sub,
        )
    if row is None:
        raise HTTPException(status_code=404, detail="G-Optimize run not found")

    channel = _SSE_CHANNEL.format(run_id=str(run_id))

    async def event_generator():
        r = None
        try:
            r = aioredis.from_url(settings.redis_url, decode_responses=True)
            pubsub = r.pubsub()
            await pubsub.subscribe(channel)
            while True:
                msg = await pubsub.get_message(
                    ignore_subscribe_messages=True, timeout=20.0
                )
                if msg is None:
                    yield ": keepalive\n\n"
                    continue
                try:
                    data  = json.loads(msg["data"])
                    event = data.get("event", "progress")
                    yield _sse(event, data)
                    if event in ("done", "error"):
                        break
                except Exception as exc:
                    logger.warning("SSE parse error for g_optimize run %s: %s", run_id, exc)
        except asyncio.CancelledError:
            pass
        except Exception as exc:
            logger.error("SSE generator failed for g_optimize run %s: %s", run_id, exc)
            try:
                yield _sse("error", {"run_id": str(run_id), "msg": str(exc)})
            except Exception:
                pass
        finally:
            if r is not None:
                try:
                    await r.aclose()
                except Exception:
                    pass

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.post("/runs/{run_id}/stop")
async def stop_run(
    run_id: UUID,
    user: Annotated[TokenData, Depends(get_current_user)],
    pool=Depends(get_pool),
):
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT status FROM g_optimize_runs WHERE id = $1 AND user_id = $2",
            str(run_id), user.sub,
        )
    if row is None:
        raise HTTPException(status_code=404, detail="G-Optimize run not found")
    if row["status"] != "running":
        raise HTTPException(status_code=409, detail=f"Run is not running (status={row['status']})")
    r = _get_redis()
    r.setex(_STOP_KEY.format(run_id=str(run_id)), _STOP_KEY_TTL, "1")
    logger.info("Stop signal set for G-Optimize run %s", run_id)
    return {"run_id": str(run_id), "status": "stop_requested"}


@router.get("/runs/{run_id}/strategies")
async def get_run_strategies(
    run_id: UUID,
    user: Annotated[TokenData, Depends(get_current_user)],
    pool=Depends(get_pool),
    tab: str = Query("passed", pattern="^(passed|failed)$"),
    sort: str = Query("sharpe", pattern="^(sharpe|win_rate|max_dd|trades)$"),
    page: int = Query(1, ge=1),
    per_page: int = Query(50, ge=1, le=200),
    run_ids: list[str] = Query(default=[]),
):
    """
    Return paginated backtest results for a G-Optimize run.

    - tab=passed: only rows with passed_threshold=TRUE
    - tab=failed: only rows with passed_threshold=FALSE
    - run_ids[]: merge additional runs into one view (multi-run checkboxes)
    """
    # Verify ownership of primary run
    async with pool.acquire() as conn:
        owner = await conn.fetchval(
            "SELECT user_id FROM g_optimize_runs WHERE id = $1", str(run_id)
        )
    if owner != user.sub:
        raise HTTPException(status_code=404, detail="G-Optimize run not found")

    passed = tab == "passed"
    all_ids = list({str(run_id)} | set(run_ids))
    offset  = (page - 1) * per_page

    sort_col = {
        "sharpe":   "br.sharpe",
        "win_rate": "br.win_rate",
        "max_dd":   "br.max_dd",
        "trades":   "br.trade_count",
    }.get(sort, "br.sharpe")
    sort_dir = "ASC" if sort == "max_dd" else "DESC"

    sql = f"""
        SELECT
            br.id               AS backtest_run_id,
            br.pair,
            br.sharpe,
            br.win_rate,
            br.max_dd,
            br.trade_count,
            br.sir_json         AS ir,
            br.passed_threshold,
            br.g_optimize_run_id AS run_id,
            br.strategy_id,
            CASE
                WHEN br.strategy_id IS NOT NULL THEN 'in_rag'
                WHEN br.passed_threshold = TRUE  THEN 'pending'
                ELSE 'none'
            END                 AS rag_status
        FROM backtest_runs br
        WHERE br.g_optimize_run_id = ANY($1)
          AND br.passed_threshold = $2
        ORDER BY {sort_col} {sort_dir} NULLS LAST
        LIMIT $3 OFFSET $4
    """
    count_sql = """
        SELECT COUNT(*) FROM backtest_runs
        WHERE g_optimize_run_id = ANY($1) AND passed_threshold = $2
    """

    async with pool.acquire() as conn:
        rows  = await conn.fetch(sql, all_ids, passed, per_page, offset)
        total = await conn.fetchval(count_sql, all_ids, passed)

    def _row(r) -> dict:
        return {
            "backtest_run_id": str(r["backtest_run_id"]),
            "pair":             r["pair"],
            "sharpe":           _f(r["sharpe"]),
            "win_rate":         _f(r["win_rate"]),
            "max_dd":           _f(r["max_dd"]),
            "trade_count":      r["trade_count"],
            "ir":               dict(r["ir"]) if r["ir"] else {},
            "passed_threshold": r["passed_threshold"],
            "run_id":           str(r["run_id"]),
            "strategy_id":      str(r["strategy_id"]) if r["strategy_id"] else None,
            "rag_status":       r["rag_status"],
        }

    return {"items": [_row(r) for r in rows], "total": total, "page": page, "per_page": per_page}


@router.post("/strategies/{backtest_id}/promote")
async def promote_strategy(
    backtest_id: UUID,
    user: Annotated[TokenData, Depends(get_current_user)],
    pool=Depends(get_pool),
):
    """
    Manually promote a failed (or pending) G-Optimize strategy to the RAG corpus.
    Sets passed_threshold=TRUE, embeds via Voyage AI, saves to strategies table,
    and links backtest_run.strategy_id.  Returns updated rag_status.
    """
    from ai.voyage_client import embed as voyage_embed
    from tasks.g_optimize import _build_rag_description

    # Verify ownership via the parent g_optimize_run
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            SELECT br.id, br.sir_json, br.sharpe, br.win_rate, br.max_dd,
                   br.trade_count, br.pair, br.timeframe, br.strategy_id
            FROM   backtest_runs br
            JOIN   g_optimize_runs gr ON gr.id = br.g_optimize_run_id
            WHERE  br.id = $1 AND gr.user_id = $2 AND br.source = 'g_optimize'
            """,
            str(backtest_id), user.sub,
        )
    if row is None:
        raise HTTPException(status_code=404, detail="G-Optimize backtest run not found")

    if row["strategy_id"] is not None:
        return {"backtest_run_id": str(backtest_id), "strategy_id": str(row["strategy_id"]), "rag_status": "in_rag"}

    sir_json = dict(row["sir_json"]) if row["sir_json"] else {}
    pair      = row["pair"]
    timeframe = row["timeframe"]
    metrics   = {
        "sharpe":      _f(row["sharpe"]),
        "win_rate":    _f(row["win_rate"]),
        "max_dd":      _f(row["max_dd"]),
        "trade_count": row["trade_count"],
    }

    # Tag SIR with g_optimize provenance
    sir_tagged = dict(sir_json)
    meta = dict(sir_tagged.get("metadata", {}))
    meta.update({"source": "g_optimize", "pair": pair, "timeframe": timeframe})
    sir_tagged["metadata"] = meta

    description = _build_rag_description(sir_json, metrics, pair, timeframe)

    # Embed (async — runs directly in the FastAPI event loop)
    embedding_str: str | None = None
    try:
        vec = await voyage_embed(description)
        embedding_str = "[" + ",".join(str(x) for x in vec) + "]"
    except Exception as exc:
        logger.warning("Voyage embed failed during promote %s: %s", backtest_id, exc)

    async with pool.acquire() as conn:
        if embedding_str:
            strategy_id = await conn.fetchval(
                """
                INSERT INTO strategies (version, ir_json, description, pair, timeframe, embedding)
                VALUES (1, $1, $2, $3, $4, $5::vector) RETURNING id
                """,
                sir_tagged, description, pair, timeframe, embedding_str,
            )
        else:
            strategy_id = await conn.fetchval(
                """
                INSERT INTO strategies (version, ir_json, description, pair, timeframe)
                VALUES (1, $1, $2, $3, $4) RETURNING id
                """,
                sir_tagged, description, pair, timeframe,
            )
        await conn.execute(
            "UPDATE backtest_runs SET passed_threshold = TRUE, strategy_id = $1 WHERE id = $2",
            str(strategy_id), str(backtest_id),
        )

    logger.info("Promoted g_optimize bt_run %s → strategy %s", backtest_id, strategy_id)
    return {"backtest_run_id": str(backtest_id), "strategy_id": str(strategy_id), "rag_status": "in_rag"}


class AnalyzeRequest(BaseModel):
    backtest_run_ids: list[str] = []   # used when scope="checked"
    run_ids:          list[str] = []   # used when scope="run"
    scope: str = "checked"             # "checked" | "run" | "all"
    model: str = "claude-sonnet-4-6"


@router.post("/analyze")
async def analyze_strategies(
    payload: AnalyzeRequest,
    user: Annotated[TokenData, Depends(get_current_user)],
    pool=Depends(get_pool),
):
    """
    Co-Pilot ranking analysis for G-Optimize strategies.

    scope="checked"  — analyse exact backtest_run_ids from request
    scope="run"      — analyse all passed strategies from the given run_ids
    scope="all"      — analyse all passed strategies from all user's runs
    """
    from ai.g_optimize_agent import analyze_and_rank

    async with pool.acquire() as conn:
        _cols = "br.id AS backtest_run_id, br.pair, br.timeframe, br.sharpe, br.win_rate, br.max_dd, br.trade_count, br.sir_json AS ir, br.g_optimize_run_id AS run_id, br.strategy_id"

        if payload.scope == "checked":
            if not payload.backtest_run_ids:
                return {"recommendations": [], "skipped": [], "skipped_reason": "No strategies selected.", "strategy_ids": {}}
            rows = await conn.fetch(
                f"""
                SELECT {_cols}
                FROM   backtest_runs br
                JOIN   g_optimize_runs gr ON gr.id = br.g_optimize_run_id
                WHERE  br.id = ANY($1) AND gr.user_id = $2 AND br.source = 'g_optimize'
                """,
                payload.backtest_run_ids, user.sub,
            )

        elif payload.scope == "run":
            if not payload.run_ids:
                return {"recommendations": [], "skipped": [], "skipped_reason": "No runs selected.", "strategy_ids": {}}
            rows = await conn.fetch(
                f"""
                SELECT {_cols}
                FROM   backtest_runs br
                JOIN   g_optimize_runs gr ON gr.id = br.g_optimize_run_id
                WHERE  br.g_optimize_run_id = ANY($1)
                  AND  gr.user_id = $2
                  AND  br.passed_threshold = TRUE
                """,
                payload.run_ids, user.sub,
            )

        else:  # "all"
            rows = await conn.fetch(
                f"""
                SELECT {_cols}
                FROM   backtest_runs br
                JOIN   g_optimize_runs gr ON gr.id = br.g_optimize_run_id
                WHERE  gr.user_id = $1 AND br.passed_threshold = TRUE
                """,
                user.sub,
            )

    if not rows:
        return {"recommendations": [], "skipped": [], "skipped_reason": "No strategies found for the selected scope.", "strategy_ids": {}}

    strategies = [
        {
            "backtest_run_id": str(r["backtest_run_id"]),
            "pair":            r["pair"],
            "timeframe":       r["timeframe"],
            "sharpe":          _f(r["sharpe"]),
            "win_rate":        _f(r["win_rate"]),
            "max_dd":          _f(r["max_dd"]),
            "trade_count":     r["trade_count"],
            "ir":              dict(r["ir"]) if r["ir"] else {},
            "run_id":          str(r["run_id"]),
        }
        for r in rows
    ]
    # strategy_id lookup: backtest_run_id → strategy_id (for Co-Pilot link)
    strategy_ids = {
        str(r["backtest_run_id"]): str(r["strategy_id"]) if r["strategy_id"] else None
        for r in rows
    }

    # Cap at 30 strategies to keep prompt size manageable; sort by Sharpe desc
    strategies.sort(key=lambda s: s.get("sharpe") or 0, reverse=True)
    strategies = strategies[:30]

    result = await analyze_and_rank(strategies, model=payload.model)
    result["strategy_ids"] = strategy_ids
    return result
