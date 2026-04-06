"""
Unit tests for the indicator library.

Tests verify:
1. Output shape and index alignment (same length as input, same index)
2. NaN pattern: warm-up period has NaN, post-warmup does not
3. Correct range for dimensionless indicators (RSI 0-100, ADX 0-100, Stoch 0-100)
4. Specific known values against hand-calculated references

Tests do NOT require a running database or Redis.
"""

import numpy as np
import pandas as pd
import pytest

from engine.indicators import adx, atr, bollinger_bands, ema, macd, rsi, sma, stochastic


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture
def simple_close() -> pd.Series:
    """20 ascending prices: 1.0, 1.1, ..., 3.0 — gives predictable EMA/SMA."""
    prices = [1.0 + i * 0.1 for i in range(20)]
    idx = pd.date_range("2022-01-01", periods=20, freq="1h", tz="UTC")
    return pd.Series(prices, index=idx, dtype="float64")


@pytest.fixture
def ohlcv_series(sample_ohlcv):
    """Return individual OHLCV series from the 500-bar fixture."""
    return (
        sample_ohlcv["open"],
        sample_ohlcv["high"],
        sample_ohlcv["low"],
        sample_ohlcv["close"],
    )


# ---------------------------------------------------------------------------
# EMA
# ---------------------------------------------------------------------------

class TestEMA:
    def test_output_length(self, simple_close):
        result = ema(simple_close, period=5)
        assert len(result) == len(simple_close)

    def test_same_index(self, simple_close):
        result = ema(simple_close, period=5)
        assert result.index.equals(simple_close.index)

    def test_warmup_nans(self, simple_close):
        period = 5
        result = ema(simple_close, period=period)
        # First `period-1` bars should be NaN (min_periods=period)
        assert result.iloc[:period - 1].isna().all()

    def test_post_warmup_not_nan(self, simple_close):
        period = 5
        result = ema(simple_close, period=period)
        assert not result.iloc[period:].isna().any()

    def test_ascending_prices_ema_lt_latest(self, simple_close):
        """EMA of ascending prices should lag behind the latest price."""
        result = ema(simple_close, period=5)
        last_valid = result.dropna().iloc[-1]
        assert last_valid < simple_close.iloc[-1]

    def test_constant_price_ema_equals_price(self):
        """EMA of a flat price series equals the price."""
        constant = pd.Series([1.08] * 50, index=pd.date_range("2022-01-01", periods=50, freq="1h", tz="UTC"))
        result = ema(constant, period=10)
        # After warmup, all values should be 1.08
        np.testing.assert_allclose(result.dropna().values, 1.08, rtol=1e-10)

    def test_name(self, simple_close):
        result = ema(simple_close, period=20)
        assert result.name == "EMA_20"


# ---------------------------------------------------------------------------
# SMA
# ---------------------------------------------------------------------------

class TestSMA:
    def test_first_valid_value(self, simple_close):
        """SMA(5) at bar 4 (0-indexed) = mean of bars 0-4."""
        period = 5
        result = sma(simple_close, period=period)
        expected = simple_close.iloc[:5].mean()
        assert abs(result.iloc[4] - expected) < 1e-10

    def test_warmup_nans(self, simple_close):
        period = 5
        result = sma(simple_close, period=period)
        assert result.iloc[:period - 1].isna().all()
        assert not pd.isna(result.iloc[period - 1])


# ---------------------------------------------------------------------------
# RSI
# ---------------------------------------------------------------------------

class TestRSI:
    def test_range_0_to_100(self, sample_ohlcv):
        result = rsi(sample_ohlcv["close"], period=14)
        valid = result.dropna()
        assert (valid >= 0).all() and (valid <= 100).all()

    def test_warmup_nans(self, sample_ohlcv):
        period = 14
        result = rsi(sample_ohlcv["close"], period=period)
        # First period-1 diffs are NaN, first rma needs period bars of diffs
        assert result.iloc[:period].isna().all()

    def test_ascending_price_rsi_high(self):
        """RSI should be close to 100 for a long sustained uptrend."""
        prices = [1.0 + i * 0.001 for i in range(200)]
        idx = pd.date_range("2022-01-01", periods=200, freq="1h", tz="UTC")
        s = pd.Series(prices, index=idx)
        result = rsi(s, period=14)
        assert result.dropna().iloc[-1] > 80

    def test_descending_price_rsi_low(self):
        """RSI should be close to 0 for a sustained downtrend."""
        prices = [2.0 - i * 0.001 for i in range(200)]
        idx = pd.date_range("2022-01-01", periods=200, freq="1h", tz="UTC")
        s = pd.Series(prices, index=idx)
        result = rsi(s, period=14)
        assert result.dropna().iloc[-1] < 20

    def test_name(self, sample_ohlcv):
        result = rsi(sample_ohlcv["close"], period=14)
        assert result.name == "RSI_14"


# ---------------------------------------------------------------------------
# MACD
# ---------------------------------------------------------------------------

class TestMACD:
    def test_returns_three_series(self, sample_ohlcv):
        line, signal, hist = macd(sample_ohlcv["close"])
        assert len(line) == len(sample_ohlcv)
        assert len(signal) == len(sample_ohlcv)
        assert len(hist) == len(sample_ohlcv)

    def test_histogram_is_line_minus_signal(self, sample_ohlcv):
        line, signal, hist = macd(sample_ohlcv["close"])
        diff = (line - signal - hist).dropna().abs()
        assert (diff < 1e-10).all()

    def test_warmup(self, sample_ohlcv):
        line, signal, hist = macd(sample_ohlcv["close"], fast=12, slow=26, signal_period=9)
        # MACD line is valid from bar 26, signal from bar 26+9-1=34
        assert line.iloc[:25].isna().all()
        assert signal.iloc[:33].isna().all()

    def test_name_convention(self, sample_ohlcv):
        line, signal, hist = macd(sample_ohlcv["close"], fast=12, slow=26, signal_period=9)
        assert "MACD" in line.name


# ---------------------------------------------------------------------------
# Bollinger Bands
# ---------------------------------------------------------------------------

class TestBollingerBands:
    def test_upper_gt_lower(self, sample_ohlcv):
        upper, middle, lower = bollinger_bands(sample_ohlcv["close"])
        valid_upper = upper.dropna()
        valid_lower = lower.dropna()
        assert (valid_upper > valid_lower).all()

    def test_middle_is_sma(self, sample_ohlcv):
        period = 20
        upper, middle, lower = bollinger_bands(sample_ohlcv["close"], period=period)
        expected_sma = sma(sample_ohlcv["close"], period=period)
        diff = (middle - expected_sma).dropna().abs()
        assert (diff < 1e-10).all()

    def test_symmetric_around_middle(self, sample_ohlcv):
        upper, middle, lower = bollinger_bands(sample_ohlcv["close"])
        upper_dist = (upper - middle).dropna()
        lower_dist = (middle - lower).dropna()
        diff = (upper_dist - lower_dist).abs()
        assert (diff < 1e-10).all()


# ---------------------------------------------------------------------------
# ATR
# ---------------------------------------------------------------------------

class TestATR:
    def test_always_positive(self, sample_ohlcv):
        result = atr(sample_ohlcv["high"], sample_ohlcv["low"], sample_ohlcv["close"])
        assert (result.dropna() > 0).all()

    def test_warmup(self, sample_ohlcv):
        period = 14
        result = atr(sample_ohlcv["high"], sample_ohlcv["low"], sample_ohlcv["close"], period=period)
        # TR[0] = high-low (valid, pandas max skips NaN components), so first ATR is at period-1
        assert result.iloc[:period - 1].isna().all()
        assert not pd.isna(result.iloc[period - 1])

    def test_flat_market_low_atr(self):
        """Flat prices should give very low ATR."""
        n = 100
        idx = pd.date_range("2022-01-01", periods=n, freq="1h", tz="UTC")
        flat = pd.Series([1.08] * n, index=idx)
        result = atr(flat, flat, flat, period=14)
        assert result.dropna().max() < 1e-6


# ---------------------------------------------------------------------------
# ADX
# ---------------------------------------------------------------------------

class TestADX:
    def test_range_0_to_100(self, sample_ohlcv):
        result = adx(sample_ohlcv["high"], sample_ohlcv["low"], sample_ohlcv["close"])
        valid = result.dropna()
        assert (valid >= 0).all() and (valid <= 100).all()

    def test_trending_market_high_adx(self):
        """A strong trend should produce ADX > 25."""
        n = 200
        idx = pd.date_range("2022-01-01", periods=n, freq="1h", tz="UTC")
        prices = pd.Series([1.0 + i * 0.001 for i in range(n)], index=idx)
        high = prices + 0.0005
        low = prices - 0.0005
        result = adx(high, low, prices, period=14)
        assert result.dropna().iloc[-1] > 25


# ---------------------------------------------------------------------------
# Stochastic
# ---------------------------------------------------------------------------

class TestStochastic:
    def test_range_0_to_100(self, sample_ohlcv):
        k, d = stochastic(sample_ohlcv["high"], sample_ohlcv["low"], sample_ohlcv["close"])
        assert (k.dropna() >= 0).all() and (k.dropna() <= 100).all()
        assert (d.dropna() >= 0).all() and (d.dropna() <= 100).all()

    def test_d_is_smoothed_k(self, sample_ohlcv):
        """D should be smoother (lower std) than K."""
        k, d = stochastic(sample_ohlcv["high"], sample_ohlcv["low"], sample_ohlcv["close"])
        assert d.dropna().std() <= k.dropna().std()
