"""
Unit tests for live/bars.py — BarBuilder tick aggregation.
"""

from __future__ import annotations

from datetime import datetime, timezone

import pytest

from live.bars import BarBuilder, OHLCVBar


def _dt(h: int, m: int = 0, s: int = 0) -> datetime:
    return datetime(2026, 4, 21, h, m, s, tzinfo=timezone.utc)


# ---------------------------------------------------------------------------
# Basic bar building
# ---------------------------------------------------------------------------

def test_first_tick_opens_bar():
    builder = BarBuilder("EURUSD", "1m")
    result = builder.update(1.08000, 1.08010, _dt(10, 0, 5))
    assert result is None   # no completed bar yet
    assert builder.bar_count == 0


def test_bar_completes_on_next_minute():
    builder = BarBuilder("EURUSD", "1m")
    builder.update(1.08000, 1.08010, _dt(10, 0, 5))   # bar opens at 10:00
    builder.update(1.08020, 1.08030, _dt(10, 0, 30))  # same minute
    completed = builder.update(1.08050, 1.08060, _dt(10, 1, 0))  # new minute

    assert completed is not None
    assert completed.pair == "EURUSD"
    assert completed.timeframe == "1m"
    assert completed.timestamp == _dt(10, 0, 0)
    assert completed.open == pytest.approx((1.08000 + 1.08010) / 2)
    assert completed.close == pytest.approx((1.08020 + 1.08030) / 2)
    assert completed.tick_count == 2
    assert builder.bar_count == 1


def test_high_low_tracked_correctly():
    builder = BarBuilder("EURUSD", "1m")
    builder.update(1.08000, 1.08010, _dt(10, 0, 5))   # mid = 1.08005
    builder.update(1.08100, 1.08110, _dt(10, 0, 15))  # high tick mid = 1.08105
    builder.update(1.07900, 1.07910, _dt(10, 0, 45))  # low tick mid = 1.07905
    completed = builder.update(1.08050, 1.08060, _dt(10, 1, 0))

    assert completed is not None
    assert completed.high == pytest.approx(1.08105)
    assert completed.low  == pytest.approx(1.07905)


def test_1h_bar_completes_on_next_hour():
    builder = BarBuilder("EURUSD", "1H")
    builder.update(1.08000, 1.08010, _dt(10, 0, 0))
    builder.update(1.08020, 1.08030, _dt(10, 30, 0))
    completed = builder.update(1.08050, 1.08060, _dt(11, 0, 0))

    assert completed is not None
    assert completed.timestamp == _dt(10, 0, 0)
    assert completed.timeframe == "1H"
    assert completed.tick_count == 2


def test_multiple_bars_accumulate_in_ring():
    builder = BarBuilder("EURUSD", "1m")
    price = 1.08000
    for minute in range(5):
        for second in [5, 30]:
            builder.update(price, price + 0.0001, _dt(10, minute, second))
            price += 0.0001
        # trigger completion
        builder.update(price, price + 0.0001, _dt(10, minute + 1, 0))

    assert builder.bar_count == 5


# ---------------------------------------------------------------------------
# Ring buffer max size
# ---------------------------------------------------------------------------

def test_ring_buffer_maxlen():
    builder = BarBuilder("EURUSD", "1m", max_bars=3)
    price = 1.08000
    for minute in range(5):
        builder.update(price, price + 0.0001, _dt(10, minute, 5))
        builder.update(price, price + 0.0001, _dt(10, minute + 1, 0))
        price += 0.0001

    assert builder.bar_count == 3  # capped at max_bars


# ---------------------------------------------------------------------------
# to_dataframe
# ---------------------------------------------------------------------------

def test_to_dataframe_empty():
    builder = BarBuilder("EURUSD", "1m")
    df = builder.to_dataframe()
    assert df.empty
    assert list(df.columns) == ["open", "high", "low", "close"]


def test_to_dataframe_returns_float64():
    builder = BarBuilder("EURUSD", "1m")
    builder.update(1.08000, 1.08010, _dt(10, 0, 5))
    builder.update(1.08020, 1.08030, _dt(10, 1, 0))  # completes bar
    df = builder.to_dataframe()

    assert not df.empty
    assert df.dtypes["close"].name == "float64"
    assert df.index.tz is not None  # UTC-aware


def test_to_dataframe_index_is_bar_open_time():
    builder = BarBuilder("EURUSD", "1m")
    builder.update(1.08000, 1.08010, _dt(10, 0, 5))
    builder.update(1.08020, 1.08030, _dt(10, 1, 0))
    df = builder.to_dataframe()

    assert df.index[0] == _dt(10, 0, 0)


# ---------------------------------------------------------------------------
# Unsupported timeframe
# ---------------------------------------------------------------------------

def test_unsupported_timeframe_raises():
    with pytest.raises(ValueError, match="1H"):
        BarBuilder("EURUSD", "4H")


# ---------------------------------------------------------------------------
# Mid price calculation
# ---------------------------------------------------------------------------

def test_mid_price_is_bid_ask_average():
    builder = BarBuilder("EURUSD", "1m")
    builder.update(1.08000, 1.08020, _dt(10, 0, 5))  # mid = 1.08010
    completed = builder.update(1.08000, 1.08020, _dt(10, 1, 0))

    assert completed is not None
    assert completed.open == pytest.approx(1.08010)
    assert completed.close == pytest.approx(1.08010)
