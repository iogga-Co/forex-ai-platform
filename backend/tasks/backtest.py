"""
Celery backtest task — Phase 1 full implementation.

Flow
----
1.  Receive strategy_id, pair, timeframe, period_start, period_end, session_id
2.  Open psycopg2 connection (sync — Celery workers are synchronous)
3.  Fetch strategy IR from `strategies` table
4.  Validate IR with StrategyIR Pydantic model
5.  Fetch OHLCV candles from `ohlcv_candles` via data/db.py
6.  Run engine/runner.run_backtest() with a Redis progress callback
7.  Store result in `backtest_runs` and `trades` tables
8.  Publish 100% complete event with result_id to the WebSocket session
9.  Return {"result_id": ..., "status": "complete"}

Idempotency
-----------
The Celery task_id is stored in `backtest_runs.celery_task_id`.
ON CONFLICT DO NOTHING prevents duplicate rows on retry.
"""

import asyncio
import logging
from datetime import datetime, timezone

import redis

from core.celery_app import celery_app
from core.config import settings
from core.redis_bridge import publish_progress
from data import db as data_db
from engine.runner import run_backtest
from engine.sir import StrategyIR

logger = logging.getLogger(__name__)

# Module-level synchronous Redis client for progress publishing.
# Lazy initialisation on first use; shared across task invocations in the worker.
_redis_client: redis.Redis | None = None


def _get_redis() -> redis.Redis:
    global _redis_client
    if _redis_client is None:
        _redis_client = redis.Redis.from_url(settings.redis_url, decode_responses=True)
    return _redis_client


@celery_app.task(
    bind=True,
    name="tasks.backtest.run",
    max_retries=2,
    default_retry_delay=10,
)
def run_backtest_task(
    self,
    strategy_id: str,
    pair: str,
    timeframe: str,
    period_start: str,  # ISO date string: "2020-01-01"
    period_end: str,
    session_id: str,
    initial_capital: float = 100_000.0,
) -> dict:
    """
    Execute a backtest as a Celery background job.

    Parameters correspond to BacktestRequest in routers/backtest.py.
    `session_id` routes WebSocket progress messages to the correct browser tab.
    """
    job_id = self.request.id
    r = _get_redis()

    def progress(pct: int, msg: str = "") -> None:
        publish_progress(r, job_id=job_id, session_id=session_id, pct=pct, msg=msg)

    try:
        progress(5, "Fetching strategy")

        with data_db.get_sync_conn(settings.database_url) as conn:
            ir_json = data_db.fetch_strategy_ir(conn, strategy_id)

        if ir_json is None:
            raise ValueError(f"Strategy {strategy_id!r} not found")

        sir = StrategyIR.model_validate(ir_json)

        progress(10, "Fetching price data")

        start_dt = datetime.fromisoformat(period_start).replace(tzinfo=timezone.utc)
        end_dt = datetime.fromisoformat(period_end).replace(tzinfo=timezone.utc)

        with data_db.get_sync_conn(settings.database_url) as conn:
            df = data_db.fetch_candles(conn, pair=pair, timeframe=timeframe,
                                        start=start_dt, end=end_dt)

        if df.empty:
            raise ValueError(
                f"No price data found for {pair} {timeframe} "
                f"{period_start} → {period_end}.  Run the backfill script first."
            )

        progress(20, f"Running backtest on {len(df)} bars")

        def engine_progress(pct: int) -> None:
            # Map engine's 5-95 range into the task's 20-90 range
            scaled = 20 + int(pct * 0.7)
            progress(scaled, "Processing")

        result = run_backtest(
            df=df,
            sir=sir,
            pair=pair,
            timeframe=timeframe,
            initial_capital=initial_capital,
            progress_callback=engine_progress,
        )

        progress(90, "Saving results")

        run_record = {
            "strategy_id": strategy_id,
            "period_start": period_start,
            "period_end": period_end,
            "pair": pair,
            "timeframe": timeframe,
            "celery_task_id": job_id,
            **result.metrics,
        }

        with data_db.get_sync_conn(settings.database_url) as conn:
            run_id = data_db.insert_backtest_run(conn, run_record)
            data_db.bulk_insert_trades(conn, run_id, result.trades)

        # Auto-summarise with Claude and store embedding (best-effort — never fails the job)
        try:
            progress(92, "Generating AI summary")
            _generate_and_store_summary(
                run_id=run_id,
                strategy_description=ir_json.get("metadata", {}).get("description", ""),
                pair=pair,
                timeframe=timeframe,
                period_start=period_start,
                period_end=period_end,
                metrics=result.metrics,
            )
        except Exception as exc:
            logger.warning("Auto-summary failed (non-fatal): %s", exc)

        # Publish completion event — UI navigates to the result page
        publish_progress(
            r,
            job_id=job_id,
            session_id=session_id,
            pct=100,
            msg="Complete",
            event_type="complete",
            extra={"result_id": run_id},
        )

        logger.info(
            "Backtest job %s complete: run_id=%s, %d trades",
            job_id,
            run_id,
            result.metrics.get("trade_count", 0),
        )

        return {"result_id": run_id, "status": "complete"}

    except Exception as exc:
        logger.exception("Backtest job %s failed: %s", job_id, exc)
        publish_progress(
            r,
            job_id=job_id,
            session_id=session_id,
            pct=0,
            msg=str(exc),
            event_type="error",
        )
        # Re-raise so Celery marks the task as FAILURE and can retry
        raise


def _generate_and_store_summary(
    run_id: str,
    strategy_description: str,
    pair: str,
    timeframe: str,
    period_start: str,
    period_end: str,
    metrics: dict,
) -> None:
    """
    Generate a Claude summary and Voyage embedding for a backtest run,
    then persist them to backtest_runs.summary_text and .embedding.

    Runs synchronously inside the Celery worker via asyncio.run().
    """
    from ai.claude_client import summarize_backtest
    from ai.voyage_client import embed

    async def _run() -> None:
        summary = await summarize_backtest(
            metrics=metrics,
            strategy_description=strategy_description,
            pair=pair,
            timeframe=timeframe,
            period_start=period_start,
            period_end=period_end,
        )
        embedding = await embed(summary)
        embedding_str = "[" + ",".join(str(x) for x in embedding) + "]"

        with data_db.get_sync_conn(settings.database_url) as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    UPDATE backtest_runs
                    SET summary_text = %s, embedding = %s::vector
                    WHERE id = %s
                    """,
                    (summary, embedding_str, run_id),
                )
            conn.commit()

        logger.info("Auto-summary stored for backtest run %s", run_id)

    asyncio.run(_run())
