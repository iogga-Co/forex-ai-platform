"""
Historical data backfill script.

Downloads 5+ years of OHLCV data from Dukascopy for the five primary Forex pairs
at 1m and 1H timeframes, applies quality checks, and inserts into TimescaleDB.

Usage (from project root):
    doppler run -- python backend/scripts/backfill.py

Options (env vars or CLI):
    BACKFILL_PAIRS      comma-separated pairs (default: EURUSD,GBPUSD,USDJPY,EURGBP,GBPJPY)
    BACKFILL_TIMEFRAMES comma-separated timeframes (default: 1m,1H)
    BACKFILL_START      start date ISO format (default: 5 years ago)
    BACKFILL_END        end date ISO format (default: yesterday)
    DATABASE_URL        required — must point to TimescaleDB
    DRY_RUN             set to "1" to log without inserting

This script is idempotent: re-running it is safe because INSERT uses
ON CONFLICT DO NOTHING.  Use it to fill gaps after the server was offline.
"""

import logging
import os
import sys
from datetime import date, timedelta
from pathlib import Path

# Allow importing from the backend root when run directly
backend_root = Path(__file__).parent.parent
sys.path.insert(0, str(backend_root))

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)-8s %(name)s %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
logger = logging.getLogger("backfill")

from core.config import settings  # noqa: E402
from data import db as data_db  # noqa: E402
from data import dukascopy  # noqa: E402
from data.quality import detect_gaps, filter_outliers  # noqa: E402

_DEFAULT_PAIRS = ["EURUSD", "GBPUSD", "USDJPY", "EURGBP", "GBPJPY", "USDCHF"]
_DEFAULT_TIMEFRAMES = ["1m", "1H"]


def _parse_date(s: str | None, default: date) -> date:
    if not s:
        return default
    return date.fromisoformat(s)


def main() -> None:
    pairs = [p.strip() for p in os.environ.get("BACKFILL_PAIRS", ",".join(_DEFAULT_PAIRS)).split(",")]
    timeframes = [t.strip() for t in os.environ.get("BACKFILL_TIMEFRAMES", ",".join(_DEFAULT_TIMEFRAMES)).split(",")]
    dry_run = os.environ.get("DRY_RUN", "0") == "1"
    strict  = os.environ.get("BACKFILL_STRICT", "0") == "1" or "--strict" in sys.argv

    end_default = date.today() - timedelta(days=1)
    start_default = end_default - timedelta(days=365 * 5)

    start = _parse_date(os.environ.get("BACKFILL_START"), start_default)
    end = _parse_date(os.environ.get("BACKFILL_END"), end_default)

    logger.info("=" * 60)
    logger.info("Backfill configuration")
    logger.info("  Pairs      : %s", ", ".join(pairs))
    logger.info("  Timeframes : %s", ", ".join(timeframes))
    logger.info("  Date range : %s → %s", start, end)
    logger.info("  Dry run    : %s", dry_run)
    logger.info("  Strict     : %s", strict)
    logger.info("=" * 60)

    summary: list[dict] = []

    for pair in pairs:
        for timeframe in timeframes:
            logger.info("--- %s %s ---", pair, timeframe)
            result = _backfill_one(pair, timeframe, start, end, dry_run)
            summary.append(result)
            if strict and result["gaps"] > 0:
                logger.error(
                    "STRICT MODE: %d gap(s) detected in %s %s — aborting",
                    result["gaps"], pair, timeframe,
                )
                sys.exit(1)
            logger.info(
                "  Inserted: %d  Skipped: %d  Gaps: %d  Outliers removed: %d",
                result["inserted"],
                result["skipped"],
                result["gaps"],
                result["outliers"],
            )

    logger.info("=" * 60)
    logger.info("Backfill summary")
    logger.info("%-12s %-6s %10s %10s %6s %8s", "Pair", "TF", "Inserted", "Skipped", "Gaps", "Outliers")
    logger.info("-" * 60)
    for r in summary:
        logger.info(
            "%-12s %-6s %10d %10d %6d %8d",
            r["pair"], r["timeframe"], r["inserted"], r["skipped"], r["gaps"], r["outliers"],
        )
    total_inserted = sum(r["inserted"] for r in summary)
    logger.info("Total bars inserted: %d", total_inserted)


def _backfill_one(
    pair: str,
    timeframe: str,
    start: date,
    end: date,
    dry_run: bool,
) -> dict:
    bars = []
    outliers_removed = 0

    try:
        for bar in dukascopy.download(pair=pair, timeframe=timeframe, start=start, end=end):
            bars.append(bar)
    except Exception as exc:
        logger.error("Download failed for %s %s: %s", pair, timeframe, exc)
        return {"pair": pair, "timeframe": timeframe, "inserted": 0, "skipped": 0, "gaps": 0, "outliers": 0}

    logger.info("  Downloaded %d bars from Dukascopy", len(bars))

    # Apply quality checks using a temporary DataFrame
    if bars:
        import pandas as pd

        df = pd.DataFrame(
            [{"timestamp": b.timestamp, "open": b.open, "high": b.high,
              "low": b.low, "close": b.close, "volume": b.volume}
             for b in bars]
        )
        df["timestamp"] = pd.to_datetime(df["timestamp"], utc=True)
        df = df.set_index("timestamp").sort_index()

        # Outlier filtering
        original_len = len(df)
        df = filter_outliers(df)
        outliers_removed = original_len - len(df)

        # Gap detection (log only — gaps in source data are expected)
        gaps = detect_gaps(df, timeframe=timeframe, ignore_weekend_gaps=True)

        # Rebuild bars from the cleaned DataFrame
        bars = []
        for ts, row in df.iterrows():
            from data.models import OHLCVBar
            bars.append(OHLCVBar(
                pair=pair,
                timeframe=timeframe,
                timestamp=ts.to_pydatetime(),
                open=float(row["open"]),
                high=float(row["high"]),
                low=float(row["low"]),
                close=float(row["close"]),
                volume=float(row["volume"]),
            ))
    else:
        gaps = []

    if dry_run:
        logger.info("  DRY RUN — not inserting %d bars", len(bars))
        return {
            "pair": pair,
            "timeframe": timeframe,
            "inserted": 0,
            "skipped": len(bars),
            "gaps": len(gaps),
            "outliers": outliers_removed,
        }

    with data_db.get_sync_conn(settings.database_url) as conn:
        inserted, skipped = data_db.bulk_insert_candles(conn, bars)

    return {
        "pair": pair,
        "timeframe": timeframe,
        "inserted": inserted,
        "skipped": skipped,
        "gaps": len(gaps),
        "outliers": outliers_removed,
    }


if __name__ == "__main__":
    main()
