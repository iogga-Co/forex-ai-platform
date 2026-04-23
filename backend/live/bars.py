"""
Live bar builder.

Aggregates OANDA tick prices into completed 1m and 1H OHLCV bars.
Each BarBuilder instance handles one pair + timeframe combination.

Design:
- update(bid, ask, tick_time) feeds a tick; returns a completed OHLCVBar when
  the bar boundary is crossed (first tick of the next bar closes the previous).
- Ring buffer (deque, maxlen=500) stores completed bars in memory — no DB reads
  required for indicator computation.
- to_dataframe() converts the ring buffer to a float64 DataFrame ready for
  engine/indicators.py functions.
- Completed bars are also persisted to ohlcv_candles (via the engine) so
  historical backtest data stays current.
"""

from __future__ import annotations

from collections import deque
from dataclasses import dataclass, field
from datetime import datetime

import pandas as pd


@dataclass
class OHLCVBar:
    pair:       str
    timeframe:  str
    timestamp:  datetime   # bar open time (UTC)
    open:       float
    high:       float
    low:        float
    close:      float
    tick_count: int = field(default=0)


class BarBuilder:
    """Aggregates ticks into OHLCV bars for a single pair + timeframe."""

    def __init__(self, pair: str, timeframe: str, max_bars: int = 500) -> None:
        if timeframe not in ("1m", "1H"):
            raise ValueError(f"BarBuilder only supports 1m and 1H, got {timeframe!r}")
        self.pair       = pair
        self.timeframe  = timeframe
        self._max_bars  = max_bars
        self._ring: deque[OHLCVBar] = deque(maxlen=max_bars)
        self._current: OHLCVBar | None = None

    # ------------------------------------------------------------------

    def _bar_open(self, t: datetime) -> datetime:
        """Floor a tick timestamp to the bar's open time."""
        if self.timeframe == "1m":
            return t.replace(second=0, microsecond=0)
        return t.replace(minute=0, second=0, microsecond=0)  # 1H

    def update(self, bid: float, ask: float, tick_time: datetime) -> OHLCVBar | None:
        """
        Feed one tick.

        Returns the just-completed OHLCVBar when the tick belongs to a new bar
        (i.e. the previous bar is now closed).  Returns None while the current
        bar is still accumulating ticks.
        """
        mid      = (bid + ask) / 2.0
        bar_open = self._bar_open(tick_time)
        completed: OHLCVBar | None = None

        if self._current is None:
            self._current = OHLCVBar(
                pair=self.pair, timeframe=self.timeframe, timestamp=bar_open,
                open=mid, high=mid, low=mid, close=mid, tick_count=1,
            )
        elif bar_open > self._current.timestamp:
            # Boundary crossed — finalise and start a new bar
            completed     = self._current
            self._ring.append(completed)
            self._current = OHLCVBar(
                pair=self.pair, timeframe=self.timeframe, timestamp=bar_open,
                open=mid, high=mid, low=mid, close=mid, tick_count=1,
            )
        else:
            # Same bar — update OHLC
            self._current.high   = max(self._current.high, mid)
            self._current.low    = min(self._current.low,  mid)
            self._current.close  = mid
            self._current.tick_count += 1

        return completed

    def to_dataframe(self) -> pd.DataFrame:
        """Convert the ring buffer to a float64 DataFrame (index = UTC timestamp)."""
        if not self._ring:
            return pd.DataFrame(
                columns=["open", "high", "low", "close"], dtype="float64"
            )
        df = pd.DataFrame([
            {"timestamp": b.timestamp,
             "open": b.open, "high": b.high, "low": b.low, "close": b.close}
            for b in self._ring
        ])
        df["timestamp"] = pd.to_datetime(df["timestamp"], utc=True)
        return df.set_index("timestamp").astype("float64")

    @property
    def bar_count(self) -> int:
        return len(self._ring)
