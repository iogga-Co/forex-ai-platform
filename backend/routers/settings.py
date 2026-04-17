"""
Settings endpoints.

GET /api/settings/ai-usage  — per-model token usage totals for the past 30 days
"""

import logging
from typing import Annotated

from fastapi import APIRouter, Depends

from core.auth import TokenData, get_current_user
from core.db import get_pool

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/settings", tags=["Settings"])


@router.get("/ai-usage")
async def get_ai_usage(
    _: Annotated[TokenData | None, Depends(get_current_user)] = None,
) -> dict:
    """Return per-model AI token usage totals for the past 30 days."""
    try:
        pool = await get_pool()
        async with pool.acquire() as conn:
            rows = await conn.fetch(
                """
                SELECT
                    model,
                    SUM(input_tokens)::bigint  AS input_total,
                    SUM(output_tokens)::bigint AS output_total,
                    COUNT(*)::int              AS call_count
                FROM ai_usage_log
                WHERE created_at >= NOW() - INTERVAL '30 days'
                GROUP BY model
                ORDER BY model
                """
            )
        return {
            "usage": [
                {
                    "model":         r["model"],
                    "input_tokens":  r["input_total"],
                    "output_tokens": r["output_total"],
                    "call_count":    r["call_count"],
                }
                for r in rows
            ]
        }
    except Exception as exc:
        logger.warning("ai-usage query failed: %s", exc)
        return {"usage": []}
