"""
SIR Parser — translates a StrategyIR document into the boolean and numeric arrays
consumed by the vectorbt portfolio runner.

Responsibilities
----------------
- Compute all indicator series required by the SIR
- Evaluate each entry condition to a boolean Series
- AND all entry conditions together
- Compute ATR-based SL/TP fractions
- Build the combined filter mask
- Build per-bar position sizes

Look-Ahead Bias Note
--------------------
This parser computes everything on the CURRENT bar's data (close prices).
The ONE-BAR SHIFT that prevents look-ahead bias is applied in runner.py,
not here.  Do NOT shift signals inside this module.
"""

import logging
from functools import reduce
from typing import Any

import numpy as np
import pandas as pd

from engine import indicators as ind
from engine.filters import combined_filter_mask
from engine.sir import IndicatorCondition, StrategyIR
from engine.sizing import atr_position_sizes

logger = logging.getLogger(__name__)


class SIRParser:
    """
    Parse a StrategyIR against an OHLCV DataFrame, producing arrays for vectorbt.

    Parameters
    ----------
    sir : validated StrategyIR object
    df  : OHLCV DataFrame with float64 columns and UTC-aware DatetimeIndex
          Columns required: open, high, low, close, volume
    """

    def __init__(self, sir: StrategyIR, df: pd.DataFrame, symbol: str = "") -> None:
        self._sir = sir
        self._df = df
        self._symbol = symbol.upper()
        self._indicator_cache: dict[str, Any] = {}

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def entry_signals(self) -> pd.Series:
        """
        Boolean Series: True on bars where ALL entry conditions are satisfied.
        Aligned to the OHLCV index.  NOT shifted (shift happens in runner.py).
        """
        condition_series = [
            self._evaluate_condition(cond)
            for cond in self._sir.entry_conditions
        ]
        combined = reduce(lambda a, b: a & b, condition_series)
        combined.name = "entry_signals"
        return combined.fillna(False)

    def exit_signals(self) -> pd.Series:
        """
        Boolean Series: True on bars where ANY indicator exit condition fires.
        Returns all-False if no indicator_exits are defined.
        """
        exits = self._sir.exit_conditions.indicator_exits
        if not exits:
            return pd.Series(False, index=self._df.index, dtype=bool)
        condition_series = [self._evaluate_condition(cond) for cond in exits]
        combined = reduce(lambda a, b: a | b, condition_series)
        combined.name = "exit_signals"
        return combined.fillna(False)

    def trailing_stop_fraction(self) -> pd.Series | None:
        """
        Per-bar trailing stop fraction (distance from peak) or None if disabled.
        """
        ts = self._sir.exit_conditions.trailing_stop
        if ts is None or not ts.enabled:
            return None
        if ts.type == "atr":
            atr_vals = self._get_indicator("ATR", period=ts.period or 14)
            mult = ts.multiplier or 1.5
            frac = (atr_vals * mult) / self._df["close"].replace(0, np.nan)
            return frac.fillna(0.01)
        if ts.type == "fixed_pips":
            pip_size = 0.01 if "JPY" in self._symbol else 0.0001
            pips = ts.pips or 20.0
            frac = (pips * pip_size) / self._df["close"].replace(0, np.nan)
            return frac.fillna(0.01)
        raise ValueError(f"Unknown trailing stop type '{ts.type}'")

    def sl_fractions(self) -> pd.Series:
        """
        Stop-loss as a fraction of close price per bar.
        vectorbt applies: SL price = execution_price * (1 - sl_fraction).
        """
        return self._stop_fraction(self._sir.exit_conditions.stop_loss)

    def tp_fractions(self) -> pd.Series:
        """
        Take-profit as a fraction of close price per bar.
        vectorbt applies: TP price = execution_price * (1 + tp_fraction).
        """
        return self._stop_fraction(self._sir.exit_conditions.take_profit)

    def filter_mask(self) -> pd.Series:
        """
        Boolean mask: True on bars where trading is permitted by the filters.
        Applied to the (already shifted) entry signals in runner.py.
        """
        f = self._sir.filters
        return combined_filter_mask(
            self._df.index,
            session=f.session,
            exclude_days=f.exclude_days,
        )

    def position_sizes(self, account_equity: float) -> pd.Series:
        """
        Per-bar position sizes in units.  NaN-safe (returns 1 on NaN bars).
        """
        sl = self._sir.exit_conditions.stop_loss
        if sl.type == "atr":
            atr_vals = self._get_indicator("ATR", period=sl.period or 14)
            return atr_position_sizes(
                atr_series=atr_vals,
                stop_multiplier=sl.multiplier or 1.5,
                account_equity=account_equity,
                risk_per_trade_pct=self._sir.position_sizing.risk_per_trade_pct,
                max_size_units=self._sir.position_sizing.max_size_units,
            )
        # Fixed stops: use max_size_units as a constant
        return pd.Series(
            float(self._sir.position_sizing.max_size_units),
            index=self._df.index,
            dtype="float64",
        )

    # ------------------------------------------------------------------
    # Private helpers
    # ------------------------------------------------------------------

    def _evaluate_condition(self, cond: IndicatorCondition) -> pd.Series:
        """Resolve one IndicatorCondition to a boolean Series."""
        series = self._resolve_indicator_series(cond)
        close = self._df["close"]
        op = cond.operator

        if op == "price_above":
            return close > series
        if op == "price_below":
            return close < series
        if op == ">":
            return series > cond.value
        if op == "<":
            return series < cond.value
        if op == ">=":
            return series >= cond.value
        if op == "<=":
            return series <= cond.value
        if op == "==":
            return series == cond.value
        if op == "crossed_above":
            # series crosses above value: was below, now at-or-above
            was_below = series.shift(1) < cond.value
            now_above = series >= cond.value
            return was_below & now_above
        if op == "crossed_below":
            was_above = series.shift(1) > cond.value
            now_below = series <= cond.value
            return was_above & now_below

        raise ValueError(f"Unknown operator '{op}'")

    def _resolve_indicator_series(self, cond: IndicatorCondition) -> pd.Series:
        """Compute the relevant indicator series for a condition."""
        name = cond.indicator
        df = self._df

        if name == "RSI":
            return self._get_indicator("RSI", period=cond.period)

        if name == "EMA":
            return self._get_indicator("EMA", period=cond.period)

        if name == "SMA":
            return self._get_indicator("SMA", period=cond.period)

        if name == "ATR":
            return self._get_indicator("ATR", period=cond.period)

        if name == "ADX":
            return self._get_indicator("ADX", period=cond.period)

        if name == "MACD":
            fast = cond.fast or 12
            slow = cond.slow or 26
            signal_period = cond.signal_period or 9
            component = cond.component or "line"
            key = f"MACD_{fast}_{slow}_{signal_period}"
            if key not in self._indicator_cache:
                line, sig, hist = ind.macd(
                    df["close"], fast=fast, slow=slow, signal_period=signal_period
                )
                self._indicator_cache[f"{key}_line"] = line
                self._indicator_cache[f"{key}_signal"] = sig
                self._indicator_cache[f"{key}_histogram"] = hist
            return self._indicator_cache[f"{key}_{component}"]

        if name == "BB":
            period = cond.period
            std = cond.std_dev or 2.0
            component = cond.component or "middle"
            key = f"BB_{period}_{std}"
            if key not in self._indicator_cache:
                upper, middle, lower = ind.bollinger_bands(
                    df["close"], period=period, std_dev=std
                )
                self._indicator_cache[f"{key}_upper"] = upper
                self._indicator_cache[f"{key}_middle"] = middle
                self._indicator_cache[f"{key}_lower"] = lower
            return self._indicator_cache[f"{key}_{component}"]

        if name == "STOCH":
            k_period = cond.period
            k_smooth = cond.k_smooth or 3
            d_period = cond.d_period or 3
            component = cond.component or "k"
            key = f"STOCH_{k_period}_{k_smooth}_{d_period}"
            if key not in self._indicator_cache:
                k, d = ind.stochastic(
                    df["high"], df["low"], df["close"],
                    k_period=k_period,
                    k_smooth=k_smooth,
                    d_period=d_period,
                )
                self._indicator_cache[f"{key}_k"] = k
                self._indicator_cache[f"{key}_d"] = d
            return self._indicator_cache[f"{key}_{component}"]

        raise ValueError(f"Unknown indicator '{name}'")

    def _get_indicator(self, name: str, period: int) -> pd.Series:
        """Cache-aware single-output indicator computation."""
        key = f"{name}_{period}"
        if key in self._indicator_cache:
            return self._indicator_cache[key]

        df = self._df
        if name == "RSI":
            result = ind.rsi(df["close"], period=period)
        elif name == "EMA":
            result = ind.ema(df["close"], period=period)
        elif name == "SMA":
            result = ind.sma(df["close"], period=period)
        elif name == "ATR":
            result = ind.atr(df["high"], df["low"], df["close"], period=period)
        elif name == "ADX":
            result = ind.adx(df["high"], df["low"], df["close"], period=period)
        else:
            raise ValueError(f"_get_indicator: unknown single-output indicator '{name}'")

        self._indicator_cache[key] = result
        return result

    def _stop_fraction(self, stop_cfg) -> pd.Series:
        """
        Convert a StopConfig to a per-bar fraction of close price.
        For ATR stops: fraction = ATR * multiplier / close
        For percent:   fraction = percent value directly
        For pips:      fraction = pips * pip_size / close  (0.01 for JPY pairs, else 0.0001)
        """
        if stop_cfg.type == "atr":
            atr_vals = self._get_indicator("ATR", period=stop_cfg.period or 14)
            mult = stop_cfg.multiplier or 1.5
            frac = (atr_vals * mult) / self._df["close"].replace(0, np.nan)
            frac.name = "stop_fraction"
            return frac.fillna(0.01)  # fallback fraction on NaN bars

        if stop_cfg.type == "percent":
            return pd.Series(
                stop_cfg.percent or 0.01,
                index=self._df.index,
                dtype="float64",
            )

        if stop_cfg.type == "fixed_pips":
            pip_size = 0.01 if "JPY" in self._symbol else 0.0001
            pips = stop_cfg.pips or 20.0
            frac = (pips * pip_size) / self._df["close"].replace(0, np.nan)
            return frac.fillna(0.01)

        raise ValueError(f"Unknown stop type '{stop_cfg.type}'")
