"""
Synchronous psycopg2 database helpers for the data pipeline and Celery workers.

FastAPI route handlers use the asyncpg pool in core/db.py instead.

Design decisions
----------------
- fetch_candles returns a float64 DataFrame (not Decimal) so it can be passed
  directly to pandas/numpy indicator functions without type conversion in caller code.
- bulk_insert_candles uses execute_values in batches for throughput.
- get_sync_conn() is a context manager — always releases the connection.
"""

import logging
from contextlib import contextmanager
from datetime import datetime
from typing import Generator

import pandas as pd
import psycopg2
import psycopg2.extras

from data.models import OHLCVBar

logger = logging.getLogger(__name__)

_BATCH_SIZE = 1_000


@contextmanager
def get_sync_conn(dsn: str) -> Generator[psycopg2.extensions.connection, None, None]:
    """Open a psycopg2 connection, yield it, then close it."""
    conn = psycopg2.connect(dsn)
    try:
        yield conn
    finally:
        conn.close()


def bulk_insert_candles(
    conn: psycopg2.extensions.connection,
    bars: list[OHLCVBar],
) -> tuple[int, int]:
    """
    Bulk-insert OHLCV bars into ohlcv_candles using ON CONFLICT DO NOTHING.

    Returns (rows_inserted, rows_skipped).
    Note: psycopg2's execute_values doesn't return per-row conflict info,
    so rows_skipped is estimated as len(bars) - rows_inserted.
    """
    if not bars:
        return 0, 0

    sql = """
        INSERT INTO ohlcv_candles (pair, timeframe, timestamp, open, high, low, close, volume)
        VALUES %s
        ON CONFLICT (pair, timeframe, timestamp) DO NOTHING
    """
    template = "(%s, %s, %s, %s, %s, %s, %s, %s)"

    total_inserted = 0
    total_skipped = 0

    for batch_start in range(0, len(bars), _BATCH_SIZE):
        batch = bars[batch_start : batch_start + _BATCH_SIZE]
        values = [
            (
                b.pair,
                b.timeframe,
                b.timestamp,
                b.open,
                b.high,
                b.low,
                b.close,
                b.volume,
            )
            for b in batch
        ]
        with conn.cursor() as cur:
            psycopg2.extras.execute_values(cur, sql, values, template=template)
            inserted = cur.rowcount if cur.rowcount >= 0 else 0
            total_inserted += inserted
            total_skipped += len(batch) - inserted
        conn.commit()

    logger.info(
        "bulk_insert_candles: %d inserted, %d skipped (conflicts)",
        total_inserted,
        total_skipped,
    )
    return total_inserted, total_skipped


def fetch_candles(
    conn: psycopg2.extensions.connection,
    pair: str,
    timeframe: str,
    start: datetime,
    end: datetime,
) -> pd.DataFrame:
    """
    Fetch OHLCV candles for a given pair/timeframe/range from TimescaleDB.

    Returns a DataFrame with:
    - DatetimeIndex: UTC-aware timestamps (bar open times)
    - Columns: open, high, low, close, volume (all float64)

    The Decimal values from NUMERIC columns are explicitly cast to float64
    here so callers never need to worry about type issues in indicator code.
    """
    sql = """
        SELECT timestamp, open, high, low, close, volume
        FROM ohlcv_candles
        WHERE pair = %s
          AND timeframe = %s
          AND timestamp >= %s
          AND timestamp < %s
        ORDER BY timestamp ASC
    """
    with conn.cursor() as cur:
        cur.execute(sql, (pair.upper(), timeframe, start, end))
        rows = cur.fetchall()

    if not rows:
        return pd.DataFrame(
            columns=["open", "high", "low", "close", "volume"],
            dtype="float64",
        )

    df = pd.DataFrame(
        rows,
        columns=["timestamp", "open", "high", "low", "close", "volume"],
    )
    df["timestamp"] = pd.to_datetime(df["timestamp"], utc=True)
    df = df.set_index("timestamp").sort_index()

    # Cast NUMERIC → float64 so indicator functions receive the expected dtype
    return df.astype("float64")


def insert_backtest_run(
    conn: psycopg2.extensions.connection,
    run: dict,
) -> str:
    """
    Insert a row into backtest_runs and return the generated UUID.

    `run` must contain all non-nullable fields.  Pass celery_task_id to enable
    idempotent retries (ON CONFLICT DO NOTHING on the unique index).
    """
    sql = """
        INSERT INTO backtest_runs (
            strategy_id, period_start, period_end, pair, timeframe,
            sharpe, sortino, max_dd, win_rate, avg_r, trade_count, total_pnl,
            celery_task_id
        )
        VALUES (
            %(strategy_id)s, %(period_start)s, %(period_end)s, %(pair)s, %(timeframe)s,
            %(sharpe)s, %(sortino)s, %(max_dd)s, %(win_rate)s, %(avg_r)s,
            %(trade_count)s, %(total_pnl)s, %(celery_task_id)s
        )
        ON CONFLICT (celery_task_id) WHERE celery_task_id IS NOT NULL DO NOTHING
        RETURNING id
    """
    with conn.cursor() as cur:
        cur.execute(sql, run)
        result = cur.fetchone()
        conn.commit()

    if result is None:
        # Conflict — fetch the existing run_id
        with conn.cursor() as cur:
            cur.execute(
                "SELECT id FROM backtest_runs WHERE celery_task_id = %s",
                (run["celery_task_id"],),
            )
            result = cur.fetchone()

    run_id = str(result[0])

    # Prune oldest runs beyond 50 per strategy (trades cascade via FK)
    _BACKTEST_CAP = 50
    with conn.cursor() as cur:
        cur.execute(
            """
            DELETE FROM backtest_runs
            WHERE strategy_id = %(strategy_id)s
              AND id NOT IN (
                SELECT id FROM backtest_runs
                WHERE strategy_id = %(strategy_id)s
                ORDER BY created_at DESC
                LIMIT %(cap)s
              )
            """,
            {"strategy_id": run["strategy_id"], "cap": _BACKTEST_CAP},
        )
    conn.commit()

    return run_id


def bulk_insert_trades(
    conn: psycopg2.extensions.connection,
    backtest_run_id: str,
    trades: list[dict],
) -> None:
    """Bulk-insert trade records for a completed backtest run."""
    if not trades:
        return

    sql = """
        INSERT INTO trades (
            backtest_run_id, entry_time, exit_time, direction,
            entry_price, exit_price, pnl, r_multiple, mae, mfe, signal_context
        )
        VALUES %s
    """
    template = "(%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)"

    import json

    for batch_start in range(0, len(trades), _BATCH_SIZE):
        batch = trades[batch_start : batch_start + _BATCH_SIZE]
        values = [
            (
                backtest_run_id,
                t["entry_time"],
                t["exit_time"],
                t["direction"],
                t["entry_price"],
                t["exit_price"],
                t["pnl"],
                t["r_multiple"],
                t["mae"],
                t["mfe"],
                json.dumps(t.get("signal_context", {})),
            )
            for t in batch
        ]
        with conn.cursor() as cur:
            psycopg2.extras.execute_values(cur, sql, values, template=template)
        conn.commit()


def fetch_strategy_ir(
    conn: psycopg2.extensions.connection,
    strategy_id: str,
) -> dict | None:
    """Fetch the ir_json for a strategy by UUID.  Returns None if not found."""
    sql = "SELECT ir_json FROM strategies WHERE id = %s"
    with conn.cursor() as cur:
        cur.execute(sql, (strategy_id,))
        row = cur.fetchone()
    return row[0] if row else None


def insert_g_optimize_backtest_run(
    conn: psycopg2.extensions.connection,
    g_optimize_run_id: str,
    pair: str,
    timeframe: str,
    period_start: str,
    period_end: str,
    sir_json: dict,
    metrics: dict,
    passed_threshold: bool,
) -> str:
    """
    Insert a backtest_run row originating from a G-Optimize discovery run.

    strategy_id is NULL (set later by embed_and_inject_rag when a strategy row
    is created for passing configs).  sir_json stores the sampled SIR so the
    strategies panel can display the full IR without a strategy FK.
    """
    import json as _json

    sql = """
        INSERT INTO backtest_runs (
            period_start, period_end, pair, timeframe,
            sharpe, sortino, max_dd, win_rate, avg_r, trade_count, total_pnl,
            source, g_optimize_run_id, passed_threshold, sir_json
        )
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s,
                'g_optimize', %s, %s, %s)
        RETURNING id
    """
    with conn.cursor() as cur:
        cur.execute(sql, (
            period_start,
            period_end,
            pair,
            timeframe,
            metrics.get("sharpe"),
            metrics.get("sortino"),
            metrics.get("max_dd"),
            metrics.get("win_rate"),
            metrics.get("avg_r"),
            metrics.get("trade_count"),
            metrics.get("total_pnl"),
            g_optimize_run_id,
            passed_threshold,
            psycopg2.extras.Json(sir_json),
        ))
        result = cur.fetchone()
    conn.commit()
    return str(result[0])
