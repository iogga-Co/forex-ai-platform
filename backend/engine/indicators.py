"""
Technical indicator library.

All functions:
- Accept and return pandas Series with the same index as the input
- Return NaN for the warm-up period (no data dropping)
- Use float64 throughout
- Match TradingView calculations:
  - EMA uses ewm(span=N, adjust=False)  — recursive formula, not initialised
  - RSI/ATR/ADX use Wilder's RMA        — ewm(alpha=1/N, adjust=False)
  - MACD is EMA(fast) - EMA(slow), signal = EMA(macd_line)
  - BB uses simple std (ddof=1)
  - Stochastic %K = (close - lowest_low) / (highest_high - lowest_low) * 100

The warm-up difference vs TradingView (first ~50 bars) is negligible on
multi-year datasets and does not affect golden dataset test outcomes because
the fixture data slice is trimmed to start well past the warm-up period.
"""

import numpy as np
import pandas as pd


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _rma(series: pd.Series, period: int) -> pd.Series:
    """Wilder's Running Moving Average (RMA).  alpha = 1/period."""
    return series.ewm(alpha=1.0 / period, min_periods=period, adjust=False).mean()


# ---------------------------------------------------------------------------
# Public indicator functions
# ---------------------------------------------------------------------------

def ema(close: pd.Series, period: int) -> pd.Series:
    """
    Exponential Moving Average.
    Matches TradingView ta.ema(): ewm with span=period, adjust=False.
    """
    result = close.ewm(span=period, min_periods=period, adjust=False).mean()
    result.name = f"EMA_{period}"
    return result


def sma(close: pd.Series, period: int) -> pd.Series:
    """Simple Moving Average."""
    result = close.rolling(window=period, min_periods=period).mean()
    result.name = f"SMA_{period}"
    return result


def rsi(close: pd.Series, period: int = 14) -> pd.Series:
    """
    Relative Strength Index using Wilder's RMA smoothing.
    Matches TradingView ta.rsi().
    """
    delta = close.diff()
    gain = delta.clip(lower=0.0)
    loss = (-delta).clip(lower=0.0)

    avg_gain = _rma(gain, period)
    avg_loss = _rma(loss, period)

    # Avoid division by zero on all-loss or all-gain streaks
    rs = avg_gain / avg_loss.replace(0.0, np.nan)
    result = 100.0 - (100.0 / (1.0 + rs))
    # Handle edge cases: all gains → RSI=100, all losses → RSI=0
    result = result.where(avg_loss != 0, 100.0)
    result = result.where(avg_gain != 0, 0.0)
    result.name = f"RSI_{period}"
    return result


def macd(
    close: pd.Series,
    fast: int = 12,
    slow: int = 26,
    signal_period: int = 9,
) -> tuple[pd.Series, pd.Series, pd.Series]:
    """
    MACD: (fast EMA − slow EMA), signal EMA, histogram.

    Returns (macd_line, signal_line, histogram) — all pd.Series.
    """
    fast_ema = close.ewm(span=fast, min_periods=fast, adjust=False).mean()
    slow_ema = close.ewm(span=slow, min_periods=slow, adjust=False).mean()
    macd_line = fast_ema - slow_ema
    signal_line = macd_line.ewm(span=signal_period, min_periods=signal_period, adjust=False).mean()
    histogram = macd_line - signal_line

    macd_line.name = f"MACD_{fast}_{slow}_{signal_period}_line"
    signal_line.name = f"MACD_{fast}_{slow}_{signal_period}_signal"
    histogram.name = f"MACD_{fast}_{slow}_{signal_period}_hist"
    return macd_line, signal_line, histogram


def bollinger_bands(
    close: pd.Series,
    period: int = 20,
    std_dev: float = 2.0,
) -> tuple[pd.Series, pd.Series, pd.Series]:
    """
    Bollinger Bands: upper, middle (SMA), lower.

    Returns (upper, middle, lower) — all pd.Series.
    Uses ddof=1 (sample std), matching TradingView.
    """
    middle = close.rolling(window=period, min_periods=period).mean()
    rolling_std = close.rolling(window=period, min_periods=period).std(ddof=1)
    upper = middle + std_dev * rolling_std
    lower = middle - std_dev * rolling_std

    upper.name = f"BB_{period}_{std_dev}_upper"
    middle.name = f"BB_{period}_{std_dev}_middle"
    lower.name = f"BB_{period}_{std_dev}_lower"
    return upper, middle, lower


def atr(
    high: pd.Series,
    low: pd.Series,
    close: pd.Series,
    period: int = 14,
) -> pd.Series:
    """
    Average True Range using Wilder's RMA smoothing.
    Matches TradingView ta.atr().

    True Range = max(high-low, |high-prev_close|, |low-prev_close|)
    """
    prev_close = close.shift(1)
    tr = pd.concat(
        [high - low, (high - prev_close).abs(), (low - prev_close).abs()],
        axis=1,
    ).max(axis=1)
    result = _rma(tr, period)
    result.name = f"ATR_{period}"
    return result


def adx(
    high: pd.Series,
    low: pd.Series,
    close: pd.Series,
    period: int = 14,
) -> pd.Series:
    """
    Average Directional Index.  Returns only the ADX line (0-100).
    Matches TradingView ta.adx().
    """
    # True Range
    prev_close = close.shift(1)
    tr = pd.concat(
        [high - low, (high - prev_close).abs(), (low - prev_close).abs()],
        axis=1,
    ).max(axis=1)

    # Directional movement
    up_move = high - high.shift(1)
    down_move = low.shift(1) - low

    pos_dm = pd.Series(
        np.where((up_move > down_move) & (up_move > 0), up_move, 0.0),
        index=high.index,
    )
    neg_dm = pd.Series(
        np.where((down_move > up_move) & (down_move > 0), down_move, 0.0),
        index=high.index,
    )

    smooth_tr = _rma(tr, period)
    smooth_pos = _rma(pos_dm, period)
    smooth_neg = _rma(neg_dm, period)

    # DI+ and DI-
    di_pos = 100.0 * smooth_pos / smooth_tr.replace(0, np.nan)
    di_neg = 100.0 * smooth_neg / smooth_tr.replace(0, np.nan)

    # DX and ADX
    dx = 100.0 * (di_pos - di_neg).abs() / (di_pos + di_neg).replace(0, np.nan)
    result = _rma(dx, period)
    result.name = f"ADX_{period}"
    return result


def stochastic(
    high: pd.Series,
    low: pd.Series,
    close: pd.Series,
    k_period: int = 14,
    k_smooth: int = 3,
    d_period: int = 3,
) -> tuple[pd.Series, pd.Series]:
    """
    Stochastic Oscillator.

    Returns (%K_smoothed, %D) — both pd.Series, values 0-100.
    Matches TradingView ta.stoch().
    """
    lowest_low = low.rolling(window=k_period, min_periods=k_period).min()
    highest_high = high.rolling(window=k_period, min_periods=k_period).max()

    range_ = (highest_high - lowest_low).replace(0, np.nan)
    raw_k = 100.0 * (close - lowest_low) / range_

    # Smooth %K
    k = raw_k.rolling(window=k_smooth, min_periods=k_smooth).mean()
    d = k.rolling(window=d_period, min_periods=d_period).mean()

    k.name = f"STOCH_{k_period}_{k_smooth}_{d_period}_k"
    d.name = f"STOCH_{k_period}_{k_smooth}_{d_period}_d"
    return k, d
