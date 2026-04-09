"""
ClickHouse client — Phase 3.

Provides schema initialisation and write helpers used by the Celery backtest
task.  All operations are best-effort; errors are logged but never propagated.

Tables
------
backtest_metrics  — one row per backtest run (aggregate metrics)
backtest_trades   — one row per trade (granular P&L, MAE/MFE)
"""

import logging
from datetime import date as date_type
from urllib.parse import urlparse

logger = logging.getLogger(__name__)

_client = None  # clickhouse_connect.driver.Client, lazy-init


def _get_client():
    global _client
    if _client is None:
        import clickhouse_connect
        from core.config import settings

        parsed = urlparse(settings.clickhouse_url)
        _client = clickhouse_connect.get_client(
            host=parsed.hostname or "clickhouse",
            port=parsed.port or 8123,
            username=parsed.username or "default",
            password=parsed.password or "",
            database=(parsed.path or "/default").lstrip("/"),
        )
    return _client


_SCHEMA: list[str] = [
    """
    CREATE TABLE IF NOT EXISTS backtest_metrics (
        run_id        UUID,
        strategy_id   UUID,
        pair          LowCardinality(String),
        timeframe     LowCardinality(String),
        period_start  Date,
        period_end    Date,
        sharpe        Nullable(Float64),
        sortino       Nullable(Float64),
        max_dd        Nullable(Float64),
        win_rate      Nullable(Float64),
        avg_r         Nullable(Float64),
        trade_count   Int32,
        total_pnl     Float64,
        created_at    DateTime64(3, 'UTC')
    )
    ENGINE = ReplacingMergeTree
    ORDER BY (strategy_id, pair, timeframe, period_start, period_end, run_id)
    """,
    """
    CREATE TABLE IF NOT EXISTS backtest_trades (
        run_id        UUID,
        strategy_id   UUID,
        pair          LowCardinality(String),
        timeframe     LowCardinality(String),
        entry_time    DateTime64(3, 'UTC'),
        exit_time     DateTime64(3, 'UTC'),
        direction     LowCardinality(String),
        entry_price   Float64,
        exit_price    Float64,
        pnl           Float64,
        r_multiple    Float64,
        mae           Float64,
        mfe           Float64,
        size          Float64,
        sl_fraction   Float64
    )
    ENGINE = ReplacingMergeTree
    ORDER BY (run_id, entry_time)
    """,
]


def init_schema() -> None:
    """Create ClickHouse tables if they don't exist. Call once at worker startup."""
    try:
        client = _get_client()
        for sql in _SCHEMA:
            client.command(sql.strip())
        logger.info("ClickHouse schema verified")
    except Exception as exc:
        logger.warning("ClickHouse schema init failed (non-fatal): %s", exc)


def write_backtest_run(
    run_id: str,
    strategy_id: str,
    pair: str,
    timeframe: str,
    period_start: str,
    period_end: str,
    metrics: dict,
    trades: list[dict],
) -> None:
    """
    Write a completed backtest run to ClickHouse.
    Idempotent — ReplacingMergeTree deduplicates on run_id.
    Called synchronously from the Celery worker (best-effort).
    """
    try:
        from datetime import datetime, timezone
        client = _get_client()

        ps = date_type.fromisoformat(period_start) if isinstance(period_start, str) else period_start
        pe = date_type.fromisoformat(period_end) if isinstance(period_end, str) else period_end
        now = datetime.now(timezone.utc)

        # --- aggregate metrics row ---
        client.insert(
            "backtest_metrics",
            [[
                run_id, strategy_id, pair, timeframe,
                ps, pe,
                metrics.get("sharpe"),
                metrics.get("sortino"),
                metrics.get("max_dd"),
                metrics.get("win_rate"),
                metrics.get("avg_r"),
                int(metrics.get("trade_count") or 0),
                float(metrics.get("total_pnl") or 0.0),
                now,
            ]],
            column_names=[
                "run_id", "strategy_id", "pair", "timeframe",
                "period_start", "period_end",
                "sharpe", "sortino", "max_dd", "win_rate", "avg_r",
                "trade_count", "total_pnl", "created_at",
            ],
        )

        # --- per-trade rows ---
        if trades:
            rows = []
            for t in trades:
                sc = t.get("signal_context") or {}
                rows.append([
                    run_id, strategy_id, pair, timeframe,
                    t["entry_time"], t["exit_time"],
                    t.get("direction", "long"),
                    float(t.get("entry_price") or 0),
                    float(t.get("exit_price") or 0),
                    float(t.get("pnl") or 0),
                    float(t.get("r_multiple") or 0),
                    float(t.get("mae") or 0),
                    float(t.get("mfe") or 0),
                    float(sc.get("size") or 0),
                    float(sc.get("sl_fraction") or 0),
                ])
            client.insert(
                "backtest_trades",
                rows,
                column_names=[
                    "run_id", "strategy_id", "pair", "timeframe",
                    "entry_time", "exit_time", "direction",
                    "entry_price", "exit_price", "pnl", "r_multiple",
                    "mae", "mfe", "size", "sl_fraction",
                ],
            )

        logger.info("ClickHouse: stored run %s with %d trades", run_id, len(trades))

    except Exception as exc:
        logger.warning("ClickHouse write failed (non-fatal): %s", exc)
