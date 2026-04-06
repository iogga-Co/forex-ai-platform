"""
Data quality checks for OHLCV candle data.

Three independent, composable functions:
- normalize_to_utc    : enforce UTC-aware index
- detect_gaps         : find missing bars (returns list, does not drop)
- filter_outliers     : remove obviously corrupt bars by z-score
"""

import logging
from datetime import datetime, timezone

import pandas as pd

logger = logging.getLogger(__name__)

# Timeframe string → expected seconds between bars
_TIMEFRAME_SECONDS: dict[str, int] = {
    "1m": 60,
    "5m": 300,
    "15m": 900,
    "30m": 1800,
    "1H": 3600,
    "4H": 14400,
    "1D": 86400,
    "1W": 604800,
}

# Gap tolerance: flag gaps larger than this multiple of the expected interval
_GAP_MULTIPLIER = 1.5

# Friday 21:00 UTC to Sunday 22:00 UTC is the Forex weekend close.
# We skip gaps that fall entirely within this window to avoid false positives.
_WEEKEND_GAP_START_WEEKDAY = 4   # Friday (0=Monday)
_WEEKEND_GAP_START_HOUR = 21
_WEEKEND_GAP_END_WEEKDAY = 6     # Sunday
_WEEKEND_GAP_END_HOUR = 22


def normalize_to_utc(df: pd.DataFrame) -> pd.DataFrame:
    """
    Ensure the DataFrame's DatetimeIndex is UTC-aware.

    - If already UTC-aware: no-op.
    - If tz-aware but non-UTC: convert to UTC.
    - If tz-naive: RAISES ValueError — callers must be explicit about the source
      timezone so we never silently misinterpret timestamps.

    Returns a DataFrame with a UTC DatetimeIndex sorted ascending.
    The tzinfo is kept on the index (TimescaleDB TIMESTAMPTZ accepts UTC strings
    from psycopg2 transparently).
    """
    if not isinstance(df.index, pd.DatetimeIndex):
        raise TypeError("DataFrame must have a DatetimeIndex")

    if df.index.tz is None:
        raise ValueError(
            "DataFrame has a timezone-naive index.  "
            "Attach UTC explicitly: df.index = df.index.tz_localize('UTC')"
        )

    df = df.copy()
    if str(df.index.tz) != "UTC":
        df.index = df.index.tz_convert("UTC")

    return df.sort_index()


def detect_gaps(
    df: pd.DataFrame,
    timeframe: str,
    ignore_weekend_gaps: bool = True,
) -> list[tuple[datetime, datetime]]:
    """
    Detect missing bars by comparing actual bar spacing against the expected interval.

    Returns a list of (gap_start, gap_end) tuples (UTC-aware datetimes).
    Does NOT modify the DataFrame — gap handling is the caller's responsibility.

    Parameters
    ----------
    df : DataFrame with UTC-aware DatetimeIndex
    timeframe : e.g. "1H", "1m"
    ignore_weekend_gaps : skip gaps that span the Forex weekend close window
    """
    if timeframe not in _TIMEFRAME_SECONDS:
        raise ValueError(
            f"Unknown timeframe '{timeframe}'.  "
            f"Supported: {list(_TIMEFRAME_SECONDS.keys())}"
        )

    expected_seconds = _TIMEFRAME_SECONDS[timeframe]
    threshold = pd.Timedelta(seconds=expected_seconds * _GAP_MULTIPLIER)

    gaps: list[tuple[datetime, datetime]] = []
    timestamps = df.index.sort_values()

    for i in range(1, len(timestamps)):
        delta = timestamps[i] - timestamps[i - 1]
        if delta <= threshold:
            continue

        gap_start = timestamps[i - 1].to_pydatetime()
        gap_end = timestamps[i].to_pydatetime()

        if ignore_weekend_gaps and _is_weekend_gap(gap_start, gap_end):
            continue

        gaps.append((gap_start, gap_end))
        logger.debug("Gap detected: %s → %s (%s)", gap_start, gap_end, delta)

    if gaps:
        logger.info("%d gaps detected in %s data", len(gaps), timeframe)

    return gaps


def _is_weekend_gap(start: datetime, end: datetime) -> bool:
    """
    Return True if the gap is entirely within the Forex weekend close window
    (Friday ~21:00 UTC to Sunday ~22:00 UTC).
    """
    # Gap starts on Friday at or after 21:00 UTC
    friday_close = (
        start.weekday() == _WEEKEND_GAP_START_WEEKDAY
        and start.hour >= _WEEKEND_GAP_START_HOUR
    )
    # Gap starts on Saturday (entirely within weekend)
    saturday = start.weekday() == 5
    # Gap ends on Sunday at or before 22:00 UTC
    sunday_open = (
        end.weekday() == _WEEKEND_GAP_END_WEEKDAY
        and end.hour <= _WEEKEND_GAP_END_HOUR
    )
    return (friday_close or saturday) and (sunday_open or end.weekday() == 5)


def filter_outliers(
    df: pd.DataFrame,
    z_threshold: float = 5.0,
    window: int = 50,
    min_periods: int = 10,
) -> pd.DataFrame:
    """
    Remove bars where the close price deviates more than z_threshold standard
    deviations from a rolling mean.

    Default threshold of 5.0 is deliberately conservative — only removes obvious
    data corruption, not legitimate volatility spikes.

    Returns a new DataFrame with outlier rows removed.
    """
    close = df["close"]
    rolling_mean = close.rolling(window=window, min_periods=min_periods).mean()
    rolling_std = close.rolling(window=window, min_periods=min_periods).std()

    # Avoid division by zero on flat data
    rolling_std = rolling_std.replace(0, float("nan"))

    z_scores = (close - rolling_mean) / rolling_std
    is_outlier = z_scores.abs() > z_threshold

    n_removed = is_outlier.sum()
    if n_removed > 0:
        for ts in df.index[is_outlier]:
            logger.warning(
                "Outlier removed at %s: close=%.5f z=%.2f",
                ts,
                df.loc[ts, "close"],
                z_scores[ts],
            )
        logger.info("Removed %d outlier bars (z_threshold=%.1f)", n_removed, z_threshold)

    return df[~is_outlier].copy()
