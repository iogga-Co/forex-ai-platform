"""
RAG backfill task — Phase 5.4.

Embeds strategies and backtest_runs that have no embedding so they appear
in hybrid RAG retrieval for the Co-Pilot.
"""

import asyncio
import logging

import psycopg2
import psycopg2.extras

from core.celery_app import celery_app
from core.config import settings

logger = logging.getLogger(__name__)


@celery_app.task(bind=True, name="tasks.rag_backfill.backfill_embeddings")
def backfill_embeddings(self) -> dict:  # type: ignore[override]
    """
    Embed rows missing embeddings:
    - strategies (active, description IS NOT NULL)
    - backtest_runs (summary_text IS NOT NULL)

    Uses asyncio.run() to call the async Voyage AI client from the sync
    Celery worker, consistent with how g_optimize.py calls voyage_embed.
    """
    from ai.voyage_client import embed_batch

    strategies_done = 0
    runs_done = 0

    with psycopg2.connect(settings.database_url) as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            # --- strategies ---
            cur.execute(
                """
                SELECT id, description
                FROM strategies
                WHERE embedding IS NULL
                  AND description IS NOT NULL
                  AND deleted_at IS NULL
                """
            )
            strat_rows = cur.fetchall()

        if strat_rows:
            texts = [r["description"] for r in strat_rows]
            try:
                vectors = asyncio.run(embed_batch(texts))
            except Exception as exc:
                logger.warning("Voyage batch embed failed for strategies: %s", exc)
                vectors = []

            with conn.cursor() as cur:
                for row, vec in zip(strat_rows, vectors):
                    if vec is None:
                        continue
                    vec_str = "[" + ",".join(str(x) for x in vec) + "]"
                    cur.execute(
                        "UPDATE strategies SET embedding = %s::vector WHERE id = %s",
                        (vec_str, row["id"]),
                    )
                    strategies_done += 1
            conn.commit()

        # --- backtest_runs ---
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                """
                SELECT id, summary_text
                FROM backtest_runs
                WHERE embedding IS NULL
                  AND summary_text IS NOT NULL
                """
            )
            run_rows = cur.fetchall()

        if run_rows:
            texts = [r["summary_text"] for r in run_rows]
            try:
                vectors = asyncio.run(embed_batch(texts))
            except Exception as exc:
                logger.warning("Voyage batch embed failed for backtest_runs: %s", exc)
                vectors = []

            with conn.cursor() as cur:
                for row, vec in zip(run_rows, vectors):
                    if vec is None:
                        continue
                    vec_str = "[" + ",".join(str(x) for x in vec) + "]"
                    cur.execute(
                        "UPDATE backtest_runs SET embedding = %s::vector WHERE id = %s",
                        (vec_str, row["id"]),
                    )
                    runs_done += 1
            conn.commit()

    logger.info(
        "RAG backfill complete: %d strategies, %d backtest_runs embedded",
        strategies_done,
        runs_done,
    )
    return {"strategies_embedded": strategies_done, "runs_embedded": runs_done}
