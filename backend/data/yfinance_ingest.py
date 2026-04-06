"""
yfinance daily OHLCV ingest.

Used for supplemental daily data.  Dukascopy is the authoritative source for
intraday data; yfinance fills in daily candles for pairs and date ranges where
Dukascopy coverage is thin.

yfinance Forex ticker format: "{BASE}{QUOTE}=X"  (e.g. "EURUSD=X")
"""

import logging
from collections.abc import Generator
from datetime import date

import pandas as pd
import yfinance as yf

from data.models import OHLCVBar

logger = logging.getLogger(__name__)

# Map our canonical pair names to yfinance ticker symbols
_PAIR_TO_TICKER: dict[str, str] = {
    "EURUSD": "EURUSD=X",
    "GBPUSD": "GBPUSD=X",
    "USDJPY": "JPY=X",
    "EURGBP": "EURGBP=X",
    "GBPJPY": "GBPJPY=X",
    "USDCHF": "CHF=X",
    "AUDUSD": "AUDUSD=X",
    "USDCAD": "CAD=X",
    "NZDUSD": "NZDUSD=X",
    "EURJPY": "EURJPY=X",
}

_TIMEFRAME = "1D"


def download(pair: str, start: date, end: date) -> Generator[OHLCVBar, None, None]:
    """
    Download daily OHLCV candles from yfinance and yield OHLCVBar instances.

    Parameters
    ----------
    pair  : canonical pair name e.g. "EURUSD"
    start : inclusive start date
    end   : exclusive end date

    Yields
    ------
    OHLCVBar with timeframe="1D" and UTC-midnight timestamps.
    """
    pair = pair.upper().replace("/", "")
    ticker = _PAIR_TO_TICKER.get(pair)
    if ticker is None:
        raise ValueError(
            f"Pair '{pair}' not in yfinance ticker map.  "
            f"Add it to _PAIR_TO_TICKER in yfinance_ingest.py."
        )

    logger.info("Downloading yfinance daily data: %s (%s) %s → %s", pair, ticker, start, end)

    try:
        df: pd.DataFrame = yf.download(
            tickers=ticker,
            start=start.isoformat(),
            end=end.isoformat(),
            interval="1d",
            auto_adjust=True,
            progress=False,
        )
    except Exception as exc:
        logger.error("yfinance download failed for %s: %s", pair, exc)
        return

    if df.empty:
        logger.warning("yfinance returned no data for %s %s–%s", pair, start, end)
        return

    # yfinance returns a DatetimeIndex that may or may not be tz-aware
    if df.index.tz is None:
        df.index = df.index.tz_localize("UTC")
    else:
        df.index = df.index.tz_convert("UTC")

    # Normalise column names (yfinance column casing can vary)
    df.columns = [c.lower() for c in df.columns]

    for ts, row in df.iterrows():
        try:
            bar = OHLCVBar(
                pair=pair,
                timeframe=_TIMEFRAME,
                timestamp=ts.to_pydatetime(),
                open=float(row["open"]),
                high=float(row["high"]),
                low=float(row["low"]),
                close=float(row["close"]),
                volume=float(row.get("volume", 0.0)),
            )
            yield bar
        except Exception as exc:
            logger.debug("Skipping yfinance bar at %s: %s", ts, exc)
