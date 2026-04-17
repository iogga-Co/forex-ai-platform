"""
AI token usage logging.

Async version used by FastAPI endpoints.
Sync version used by Celery tasks (optimization_agent).
Both are fire-and-forget — errors are logged but never raised.
"""

import logging

logger = logging.getLogger(__name__)


async def log_usage(
    model: str,
    input_tokens: int,
    output_tokens: int,
    feature: str = "unknown",
) -> None:
    """Log AI token usage (async — for FastAPI request handlers)."""
    try:
        from core.db import get_pool
        pool = await get_pool()
        async with pool.acquire() as conn:
            await conn.execute(
                """
                INSERT INTO ai_usage_log (model, feature, input_tokens, output_tokens)
                VALUES ($1, $2, $3, $4)
                """,
                model, feature, input_tokens, output_tokens,
            )
    except Exception as exc:
        logger.warning("Failed to log AI usage: %s", exc)


def log_usage_sync(
    model: str,
    input_tokens: int,
    output_tokens: int,
    feature: str = "unknown",
) -> None:
    """Log AI token usage (sync — for Celery tasks)."""
    try:
        import psycopg2
        from core.config import settings
        conn = psycopg2.connect(settings.database_url)
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO ai_usage_log (model, feature, input_tokens, output_tokens)
                VALUES (%s, %s, %s, %s)
                """,
                (model, feature, input_tokens, output_tokens),
            )
        conn.commit()
        conn.close()
    except Exception as exc:
        logger.warning("Failed to log AI usage (sync): %s", exc)
