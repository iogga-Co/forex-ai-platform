"""
RAG Evaluation endpoints — Phase 5.4.

GET  /api/rag/coverage  — embedding coverage stats for all RAG-indexed tables.
POST /api/rag/backfill  — enqueue a Celery task to embed missing rows.
"""

import logging
from typing import Annotated

from fastapi import APIRouter, Depends

from core.auth import TokenData, get_current_user
from core.db import get_pool

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/rag", tags=["RAG"])


@router.get("/coverage")
async def coverage(
    _: Annotated[TokenData, Depends(get_current_user)],
) -> dict:
    """
    Return embedding coverage for strategies, backtest_runs, and conversation_turns,
    plus count of retrievals in the last 24 hours.
    """
    pool = await get_pool()
    async with pool.acquire() as conn:
        strat = await conn.fetchrow(
            """
            SELECT COUNT(*) AS total,
                   COUNT(embedding) AS embedded
            FROM strategies
            WHERE deleted_at IS NULL
            """
        )
        runs = await conn.fetchrow(
            """
            SELECT COUNT(*) AS total,
                   COUNT(embedding) AS embedded
            FROM backtest_runs
            """
        )
        turns = await conn.fetchrow(
            """
            SELECT COUNT(*) AS total,
                   COUNT(embedding) AS embedded
            FROM conversation_turns
            """
        )
        recent = await conn.fetchval(
            "SELECT COUNT(*) FROM rag_retrievals WHERE created_at > NOW() - INTERVAL '24 hours'"
        )

    return {
        "strategies": {
            "total": strat["total"],
            "embedded": strat["embedded"],
        },
        "backtest_runs": {
            "total": runs["total"],
            "embedded": runs["embedded"],
        },
        "conversation_turns": {
            "total": turns["total"],
            "embedded": turns["embedded"],
        },
        "recent_retrievals_24h": recent,
    }


@router.post("/backfill", status_code=202)
async def trigger_backfill(
    _: Annotated[TokenData, Depends(get_current_user)],
) -> dict:
    """
    Enqueue a Celery task to embed any strategies and backtest_runs that are
    missing embeddings. Returns immediately with the task ID.
    """
    from tasks.rag_backfill import backfill_embeddings

    task = backfill_embeddings.delay()
    logger.info("RAG backfill task enqueued: %s", task.id)
    return {"job_id": task.id}
