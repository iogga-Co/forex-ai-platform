"""
ATR-based position sizing.

Calculates position size in units for each bar so that the dollar risk per trade
(entry → stop) equals `risk_per_trade_pct` percent of `account_equity`.

For Forex:
  dollar_risk = account_equity * risk_per_trade_pct / 100
  stop_distance_price = ATR * stop_multiplier          (in price units, e.g. 0.0015)
  size_units = dollar_risk / stop_distance_price       (units of base currency)

The result is capped at max_size_units and floored at 1.

Note: For a proper broker-model simulation (with pip values, lot sizes, and
account currency conversion), additional parameters are needed.  This function
provides a deterministic, structurally correct implementation for Phase 1.
Refinement for live trading happens in Phase 4.
"""

import numpy as np
import pandas as pd


def atr_position_sizes(
    atr_series: pd.Series,
    stop_multiplier: float,
    account_equity: float,
    risk_per_trade_pct: float,
    max_size_units: int,
) -> pd.Series:
    """
    Compute per-bar ATR-based position sizes in units.

    Parameters
    ----------
    atr_series        : ATR values aligned to the OHLCV index
    stop_multiplier   : ATR multiplier for stop distance (e.g. 1.5)
    account_equity    : account value in account currency
    risk_per_trade_pct: risk per trade as a percentage (e.g. 2.0 = 2%)
    max_size_units    : hard cap on position size

    Returns
    -------
    pd.Series of integer position sizes (dtype float64, integers for vectorbt)
    """
    dollar_risk = account_equity * (risk_per_trade_pct / 100.0)
    stop_distance = atr_series * stop_multiplier

    # Avoid division by zero on bars where ATR is zero (shouldn't happen on real data)
    stop_distance = stop_distance.replace(0.0, np.nan)

    raw_size = dollar_risk / stop_distance

    # Floor at 1, cap at max_size_units, NaN → 1
    sizes = raw_size.clip(lower=1.0, upper=float(max_size_units)).fillna(1.0)
    return sizes
