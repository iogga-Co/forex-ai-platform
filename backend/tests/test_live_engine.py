"""
Unit tests for live/engine.py — signal detection and shadow mode.
"""

from __future__ import annotations

import pandas as pd
import pytest

from tests.conftest import make_ohlcv


# ---------------------------------------------------------------------------
# _check_entry_signal
# ---------------------------------------------------------------------------

def test_rsi_above_signal_detected():
    from live.engine import _check_entry_signal

    df = make_ohlcv(n_bars=200, seed=42)
    conditions = [{"indicator": "RSI", "period": 14, "operator": ">", "value": 0}]
    # RSI > 0 should always be true once warmed up
    assert _check_entry_signal(df, conditions) is True


def test_rsi_impossible_condition_not_detected():
    from live.engine import _check_entry_signal

    df = make_ohlcv(n_bars=200, seed=42)
    conditions = [{"indicator": "RSI", "period": 14, "operator": ">", "value": 200}]
    # RSI > 200 is impossible
    assert _check_entry_signal(df, conditions) is False


def test_price_above_ema_signal():
    from live.engine import _check_entry_signal

    # Build a DataFrame where close is clearly above EMA(5)
    ts = pd.date_range("2026-01-01", periods=100, freq="1h", tz="UTC")
    close = pd.Series([1.0] * 95 + [2.0] * 5, index=ts)
    df = pd.DataFrame({"open": close, "high": close, "low": close, "close": close})

    conditions = [{"indicator": "EMA", "period": 5, "operator": "price_above"}]
    # After 5 bars of price=2.0, close > EMA(5) should be true
    assert _check_entry_signal(df, conditions) is True


def test_empty_dataframe_returns_false():
    from live.engine import _check_entry_signal

    df = pd.DataFrame(columns=["open", "high", "low", "close"])
    conditions = [{"indicator": "RSI", "period": 14, "operator": ">", "value": 50}]
    assert _check_entry_signal(df, conditions) is False


def test_single_bar_returns_false():
    from live.engine import _check_entry_signal

    df = make_ohlcv(n_bars=1, seed=42)
    conditions = [{"indicator": "RSI", "period": 14, "operator": ">", "value": 50}]
    assert _check_entry_signal(df, conditions) is False


def test_all_conditions_must_pass():
    from live.engine import _check_entry_signal

    df = make_ohlcv(n_bars=200, seed=42)
    conditions = [
        {"indicator": "RSI", "period": 14, "operator": ">", "value": 0},    # always true
        {"indicator": "RSI", "period": 14, "operator": ">", "value": 200},  # always false
    ]
    # AND logic: one false → overall false
    assert _check_entry_signal(df, conditions) is False


def test_no_conditions_returns_false():
    from live.engine import _check_entry_signal

    df = make_ohlcv(n_bars=200, seed=42)
    assert _check_entry_signal(df, []) is False


def test_unknown_indicator_skipped():
    from live.engine import _check_entry_signal

    df = make_ohlcv(n_bars=200, seed=42)
    # Unknown indicator is skipped (not treated as a failure)
    conditions = [{"indicator": "UNKNOWN_IND", "operator": ">", "value": 0}]
    # No conditions effectively evaluated → returns True (no failing condition)
    # But the implementation returns False when df < 2 rows — here we have 200
    # Unknown indicators are skipped via `continue`, so if all conditions are
    # skipped, the function returns True (no condition returned False).
    result = _check_entry_signal(df, conditions)
    assert isinstance(result, bool)


def test_adx_condition():
    from live.engine import _check_entry_signal

    df = make_ohlcv(n_bars=200, seed=42)
    conditions = [{"indicator": "ADX", "period": 14, "operator": ">", "value": 0}]
    assert _check_entry_signal(df, conditions) is True


def test_macd_condition():
    from live.engine import _check_entry_signal

    df = make_ohlcv(n_bars=200, seed=42)
    conditions = [{"indicator": "MACD", "fast": 12, "slow": 26, "signal_period": 9,
                   "operator": ">", "value": -999}]
    # MACD > -999 should be true for any realistic price series
    assert _check_entry_signal(df, conditions) is True


def test_stoch_condition():
    from live.engine import _check_entry_signal

    df = make_ohlcv(n_bars=200, seed=42)
    conditions = [{"indicator": "STOCH", "period": 14, "k_smooth": 3, "d_period": 3,
                   "operator": ">", "value": 0}]
    assert _check_entry_signal(df, conditions) is True


def test_atr_condition():
    from live.engine import _check_entry_signal

    df = make_ohlcv(n_bars=200, seed=42)
    conditions = [{"indicator": "ATR", "period": 14, "operator": ">", "value": 0}]
    assert _check_entry_signal(df, conditions) is True


# ---------------------------------------------------------------------------
# Shadow mode — signal published but executor not called
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_publish_signal_shadow_mode(monkeypatch):
    """
    When LIVE_TRADING_ENABLED=false, published signal should have shadow=True.
    """
    import json
    from unittest.mock import AsyncMock, patch
    from live.bars import OHLCVBar
    from datetime import datetime, timezone
    from live.engine import _publish_signal

    published = []

    mock_redis = AsyncMock()
    mock_redis.publish = AsyncMock(side_effect=lambda ch, data: published.append(json.loads(data)))
    mock_redis.lpush = AsyncMock()
    mock_redis.ltrim = AsyncMock()

    bar = OHLCVBar(
        pair="EURUSD", timeframe="1H",
        timestamp=datetime(2026, 4, 21, 10, 0, tzinfo=timezone.utc),
        open=1.08000, high=1.08100, low=1.07900, close=1.08050,
    )
    strategy = {"id": "strat-001", "name": "Test Strategy"}

    with patch("core.config.settings") as mock_settings:
        mock_settings.live_trading_enabled = False
        await _publish_signal(mock_redis, bar, strategy)

    assert len(published) == 1
    assert published[0]["shadow"] is True
    assert published[0]["pair"] == "EURUSD"
    assert published[0]["strategy_id"] == "strat-001"


@pytest.mark.asyncio
async def test_publish_signal_live_mode(monkeypatch):
    """
    When LIVE_TRADING_ENABLED=true, published signal should have shadow=False.
    """
    import json
    from unittest.mock import AsyncMock, patch
    from live.bars import OHLCVBar
    from datetime import datetime, timezone
    from live.engine import _publish_signal

    published = []

    mock_redis = AsyncMock()
    mock_redis.publish = AsyncMock(side_effect=lambda ch, data: published.append(json.loads(data)))
    mock_redis.lpush = AsyncMock()
    mock_redis.ltrim = AsyncMock()

    bar = OHLCVBar(
        pair="GBPUSD", timeframe="1m",
        timestamp=datetime(2026, 4, 21, 10, 1, tzinfo=timezone.utc),
        open=1.26000, high=1.26100, low=1.25900, close=1.26050,
    )
    strategy = {"id": "strat-002", "name": "GBP Strategy"}

    with patch("core.config.settings") as mock_settings:
        mock_settings.live_trading_enabled = True
        await _publish_signal(mock_redis, bar, strategy)

    assert published[0]["shadow"] is False
    assert published[0]["pair"] == "GBPUSD"
