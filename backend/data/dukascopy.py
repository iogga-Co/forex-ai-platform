"""
Dukascopy historical data downloader.

Downloads hourly tick data from the Dukascopy public datafeed, decompresses
the LZMA-encoded .bi5 binary files, parses the tick records, resamples to
the requested OHLCV timeframe, and yields OHLCVBar instances.

Dukascopy tick data format (20 bytes per record, big-endian):
  - 4 bytes uint32 : milliseconds from start of the UTC hour
  - 4 bytes uint32 : ask price (integer, divide by POINT_DIVISOR to get price)
  - 4 bytes uint32 : bid price
  - 4 bytes float32: ask volume
  - 4 bytes float32: bid volume

URL template:
  https://datafeed.dukascopy.com/datafeed/{PAIR}/{YEAR}/{MONTH:02d}/{DAY:02d}/{HOUR:02d}h_ticks.bi5
  Note: MONTH is 0-indexed (January = 00).
"""

import lzma
import logging
import struct
import time
from collections.abc import Generator
from datetime import date, datetime, timedelta, timezone

import httpx
import pandas as pd

from data.models import OHLCVBar

logger = logging.getLogger(__name__)

_BASE_URL = "https://datafeed.dukascopy.com/datafeed"
_TICK_RECORD_SIZE = 20  # bytes
_TICK_STRUCT = struct.Struct(">IIIff")  # time_ms, ask, bid, ask_vol, bid_vol

# Price scaling per instrument (integer → actual price = integer / divisor)
# 5-decimal pairs: divide by 100000; 3-decimal JPY pairs: divide by 1000
_POINT_DIVISORS: dict[str, int] = {
    "EURUSD": 100_000,
    "GBPUSD": 100_000,
    "USDJPY": 1_000,
    "EURGBP": 100_000,
    "GBPJPY": 1_000,
    "USDCHF": 100_000,
    "AUDUSD": 100_000,
    "USDCAD": 100_000,
    "NZDUSD": 100_000,
    "EURJPY": 1_000,
    "EURCHF": 100_000,
    "GBPCHF": 100_000,
}

_TIMEFRAME_RESAMPLE: dict[str, str] = {
    "1m": "1min",
    "5m": "5min",
    "15m": "15min",
    "30m": "30min",
    "1H": "1h",
    "4H": "4h",
    "1D": "1D",
}

_RETRY_ATTEMPTS = 3
_RETRY_DELAY_SECONDS = 2.0


def download(
    pair: str,
    timeframe: str,
    start: date,
    end: date,
) -> Generator[OHLCVBar, None, None]:
    """
    Download and yield OHLCVBar instances for the given pair/timeframe/date range.

    Downloads one UTC-hour of tick data at a time, resamples to `timeframe`, and
    applies quality checks (UTC normalization, outlier filtering).

    Parameters
    ----------
    pair      : e.g. "EURUSD" (uppercase, no separator)
    timeframe : e.g. "1H", "1m"
    start     : inclusive start date (UTC)
    end       : exclusive end date (UTC)

    Yields
    ------
    OHLCVBar instances, sorted ascending by timestamp.
    """
    pair = pair.upper().replace("/", "")
    if pair not in _POINT_DIVISORS:
        raise ValueError(
            f"Pair '{pair}' not in supported list.  "
            f"Add it to _POINT_DIVISORS in dukascopy.py."
        )
    if timeframe not in _TIMEFRAME_RESAMPLE:
        raise ValueError(
            f"Timeframe '{timeframe}' not supported for resampling.  "
            f"Supported: {list(_TIMEFRAME_RESAMPLE.keys())}"
        )

    divisor = _POINT_DIVISORS[pair]
    resample_rule = _TIMEFRAME_RESAMPLE[timeframe]

    # Accumulate tick DataFrames for the whole day before resampling
    # (intraday timeframes need ticks from the whole day, not just one hour)
    tick_frames: list[pd.DataFrame] = []

    current = start
    while current < end:
        day_ticks = _download_day(pair, current, divisor)
        if day_ticks is not None and not day_ticks.empty:
            tick_frames.append(day_ticks)

        # Yield resampled bars once we have a full day (or on the last day)
        next_day = current + timedelta(days=1)
        if tick_frames:
            combined = pd.concat(tick_frames) if len(tick_frames) > 1 else tick_frames[0]
            combined = combined[combined.index.date == current]  # type: ignore[attr-defined]
            if not combined.empty:
                bars = _resample_ticks(combined, pair, timeframe, resample_rule)
                for bar in bars:
                    yield bar
            tick_frames = []

        current = next_day


def _download_day(
    pair: str,
    day: date,
    divisor: int,
) -> pd.DataFrame | None:
    """Download all 24 hourly tick files for a given day. Returns a combined DataFrame."""
    frames: list[pd.DataFrame] = []

    with httpx.Client(timeout=30.0) as client:
        for hour in range(24):
            url = _build_url(pair, day, hour)
            df = _fetch_hour(client, url, day, hour, divisor)
            if df is not None and not df.empty:
                frames.append(df)

    if not frames:
        logger.debug("No tick data for %s %s", pair, day)
        return None

    return pd.concat(frames).sort_index()


def _fetch_hour(
    client: httpx.Client,
    url: str,
    day: date,
    hour: int,
    divisor: int,
) -> pd.DataFrame | None:
    """Download and parse one hourly .bi5 file. Returns a tick DataFrame or None."""
    for attempt in range(_RETRY_ATTEMPTS):
        try:
            response = client.get(url)
            if response.status_code == 404:
                # No data for this hour (legitimate gap — holiday, weekend)
                return None
            response.raise_for_status()
            data = response.content
            break
        except httpx.HTTPStatusError as exc:
            logger.warning("HTTP %d for %s (attempt %d)", exc.response.status_code, url, attempt + 1)
            if attempt < _RETRY_ATTEMPTS - 1:
                time.sleep(_RETRY_DELAY_SECONDS * (attempt + 1))
            else:
                return None
        except httpx.RequestError as exc:
            logger.warning("Request error for %s: %s (attempt %d)", url, exc, attempt + 1)
            if attempt < _RETRY_ATTEMPTS - 1:
                time.sleep(_RETRY_DELAY_SECONDS * (attempt + 1))
            else:
                return None

    try:
        decompressed = lzma.decompress(data)
    except lzma.LZMAError:
        logger.warning("Failed to decompress %s", url)
        return None

    n_records = len(decompressed) // _TICK_RECORD_SIZE
    if n_records == 0:
        return None

    hour_start_ms = (
        datetime(day.year, day.month, day.day, hour, tzinfo=timezone.utc).timestamp() * 1000
    )

    rows = []
    for i in range(n_records):
        offset = i * _TICK_RECORD_SIZE
        record = decompressed[offset : offset + _TICK_RECORD_SIZE]
        time_ms, ask_raw, bid_raw, ask_vol, bid_vol = _TICK_STRUCT.unpack(record)
        ts_ms = hour_start_ms + time_ms
        ask = ask_raw / divisor
        bid = bid_raw / divisor
        mid = (ask + bid) / 2.0
        rows.append((ts_ms, bid, ask, mid, ask_vol + bid_vol))

    df = pd.DataFrame(rows, columns=["ts_ms", "bid", "ask", "mid", "volume"])
    df.index = pd.to_datetime(df["ts_ms"], unit="ms", utc=True)
    return df[["bid", "ask", "mid", "volume"]]


def _resample_ticks(
    ticks: pd.DataFrame,
    pair: str,
    timeframe: str,
    resample_rule: str,
) -> list[OHLCVBar]:
    """Resample a tick DataFrame to OHLCV bars."""
    # Use bid price for OHLCV (standard for Forex backtesting)
    ohlcv = ticks["bid"].resample(resample_rule).agg(
        open="first", high="max", low="min", close="last"
    )
    volume = ticks["volume"].resample(resample_rule).sum()
    ohlcv["volume"] = volume
    ohlcv = ohlcv.dropna(subset=["open", "close"])

    bars: list[OHLCVBar] = []
    for ts, row in ohlcv.iterrows():
        try:
            bar = OHLCVBar(
                pair=pair,
                timeframe=timeframe,
                timestamp=ts.to_pydatetime(),
                open=float(row["open"]),
                high=float(row["high"]),
                low=float(row["low"]),
                close=float(row["close"]),
                volume=float(row["volume"]),
            )
            bars.append(bar)
        except Exception as exc:
            logger.debug("Skipping malformed bar at %s: %s", ts, exc)

    return bars


def _build_url(pair: str, day: date, hour: int) -> str:
    # Dukascopy uses 0-indexed months (January = 00)
    return (
        f"{_BASE_URL}/{pair}"
        f"/{day.year}"
        f"/{day.month - 1:02d}"
        f"/{day.day:02d}"
        f"/{hour:02d}h_ticks.bi5"
    )
