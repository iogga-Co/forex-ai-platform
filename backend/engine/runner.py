"""
vectorbt portfolio runner.

Takes a validated StrategyIR and an OHLCV DataFrame, runs the full backtest,
and returns a BacktestResult with aggregated metrics and a per-trade list.

Look-Ahead Bias Prevention
--------------------------
Signals are computed on the CLOSE of bar N.
Execution happens at the OPEN of bar N+1.

This is achieved by passing `price = df["open"].shift(-1)` to vectorbt
(i.e. the next bar's open is used as the execution price for the signal
that fires on bar N).  The last bar gets close[N] as a fallback because
there is no "next open" for the final bar.

The SL/TP fractions are computed on bar N's data (ATR, close), which is the
correct reference: volatility as of signal generation time.

Determinism Guarantee
---------------------
Given identical (df, sir, initial_capital) inputs, run_backtest() always
returns identical outputs.  vectorbt uses numba JIT internally; numba kernels
are deterministic once compiled.  The first run may be slower (compilation).
"""

import logging
from dataclasses import dataclass
from typing import Callable

import pandas as pd
import vectorbt as vbt

from engine.metrics import extract_metrics, extract_trades
from engine.parser import SIRParser
from engine.sir import StrategyIR

logger = logging.getLogger(__name__)

_VBT_VERSION = "0.26.2"

# Spread modelled as a flat round-trip fee per trade (fraction of trade value).
# Derived from: typical_spread_pips * pip_size / typical_price
# JPY pairs use pip_size=0.01; all others use pip_size=0.0001.
_PAIR_FEES: dict[str, float] = {
    "EURUSD": 6.5e-5,   # ~0.7 pip  / 1.08
    "GBPUSD": 7.8e-5,   # ~1.0 pip  / 1.28
    "EURGBP": 1.4e-4,   # ~1.2 pip  / 0.86
    "USDCHF": 9.2e-5,   # ~1.0 pip  / 0.91 (pip=0.0001, price~0.91)
    "USDJPY": 6.9e-5,   # ~1.0 pip  / 145  (pip=0.01)
    "GBPJPY": 1.7e-4,   # ~2.5 pips / 185  (pip=0.01)
}
_DEFAULT_FEES = 1.0e-4  # conservative fallback for any unlisted pair

# Timeframe string → pandas/vectorbt frequency string for Sharpe annualisation
_TIMEFRAME_FREQ: dict[str, str] = {
    "1m": "1min",
    "5m": "5min",
    "15m": "15min",
    "30m": "30min",
    "1H": "1h",
    "4H": "4h",
    "1D": "1D",
    "1W": "1W",
}


@dataclass
class BacktestResult:
    metrics: dict
    trades: list[dict]
    pair: str = ""
    timeframe: str = ""
    period_start: str = ""
    period_end: str = ""


def run_backtest(
    df: pd.DataFrame,
    sir: StrategyIR,
    pair: str = "",
    timeframe: str = "1H",
    initial_capital: float = 100_000.0,
    progress_callback: Callable[[int], None] | None = None,
) -> BacktestResult:
    """
    Run a complete backtest and return metrics + trade list.

    Parameters
    ----------
    df               : OHLCV DataFrame (float64, UTC-aware DatetimeIndex)
    sir              : validated StrategyIR object
    pair             : instrument name for result metadata
    timeframe        : bar timeframe string (e.g. "1H") for annualisation
    initial_capital  : starting account equity
    progress_callback: optional callable(pct: int) for streaming progress

    Returns
    -------
    BacktestResult with .metrics dict and .trades list
    """
    _validate_df(df)

    def _progress(pct: int) -> None:
        if progress_callback:
            try:
                progress_callback(pct)
            except Exception:
                pass  # progress is best-effort

    _progress(5)

    # --- Parse SIR into signal arrays ---
    parser = SIRParser(sir, df, symbol=pair)
    raw_entries = parser.entry_signals()          # bar N signals
    sl_fracs = parser.sl_fractions()              # based on bar N data
    tp_fracs = parser.tp_fractions()              # based on bar N data
    filter_mask = parser.filter_mask()            # based on execution bar
    sizes = parser.position_sizes(initial_capital)

    _progress(20)

    # --- Exit mode: build exits series from indicator exits ---
    exit_mode = sir.exit_conditions.exit_mode
    if exit_mode == "first":
        # Any indicator exit OR SL/TP closes the trade
        exits_series = parser.exit_signals()
    else:
        # "stops_only": indicator exits ignored (current default behaviour)
        # "all": requires indicator exit AND SL/TP simultaneously — complex;
        #        conservative fallback is stops_only until custom post-run logic added
        exits_series = pd.Series(False, index=df.index)

    _progress(25)

    # --- Apply one-bar shift: execute at next open (no look-ahead bias) ---
    # Execution price: next bar's open.  Last bar has no "next open" → use close.
    next_open = df["open"].shift(-1).fillna(df["close"])

    # Filter mask is aligned to the OHLCV index (execution bar = same index).
    entries = raw_entries & filter_mask

    _progress(30)

    # --- Build vectorbt portfolio ---
    freq = _TIMEFRAME_FREQ.get(timeframe, "1h")
    fees = _PAIR_FEES.get(pair.upper(), _DEFAULT_FEES)

    logger.info(
        "Running vectorbt backtest: %s bars, %d entry signals",
        len(df),
        int(entries.sum()),
    )

    # Assemble portfolio kwargs; trailing stop params added only when enabled
    portfolio_kwargs: dict = dict(
        close=df["close"],
        open=df["open"],
        high=df["high"],
        low=df["low"],
        entries=entries,
        exits=exits_series,
        price=next_open,         # execute at next bar's open
        size=sizes,
        size_type="amount",      # sizes are in units of the base currency
        sl_stop=sl_fracs,        # fraction of entry price
        tp_stop=tp_fracs,        # fraction of entry price
        fees=fees,
        init_cash=initial_capital,
        freq=freq,
        upon_opposite_entry="ignore",  # no reversals in Phase 1 (long-only)
    )

    # Trailing stop: vectorbt 0.26.2 uses sl_trail=True to make sl_stop trailing.
    # When enabled, the trailing stop fraction replaces the fixed sl_stop.
    # Note: per-bar activation threshold (activation_multiplier) is not natively
    # supported in this vectorbt version — trailing starts from entry immediately.
    tsl_fracs = parser.trailing_stop_fraction()
    if tsl_fracs is not None:
        portfolio_kwargs["sl_stop"] = tsl_fracs   # trailing distance replaces fixed SL
        portfolio_kwargs["sl_trail"] = True

    try:
        portfolio = vbt.Portfolio.from_signals(**portfolio_kwargs)
    except Exception as exc:
        logger.error("vectorbt portfolio run failed: %s", exc)
        raise

    _progress(75)

    # --- Extract metrics and trade list ---
    metrics = extract_metrics(portfolio)
    trades = extract_trades(portfolio, df, sl_fracs)

    _progress(95)

    period_start = str(df.index[0].date()) if len(df) > 0 else ""
    period_end = str(df.index[-1].date()) if len(df) > 0 else ""

    logger.info(
        "Backtest complete: %d trades, Sharpe=%.3f, MaxDD=%.2f%%",
        metrics["trade_count"],
        metrics["sharpe"] or 0.0,
        (metrics["max_dd"] or 0.0) * 100,
    )

    return BacktestResult(
        metrics=metrics,
        trades=trades,
        pair=pair,
        timeframe=timeframe,
        period_start=period_start,
        period_end=period_end,
    )


def _validate_df(df: pd.DataFrame) -> None:
    """Raise ValueError if the DataFrame is unusable for backtesting."""
    required = {"open", "high", "low", "close"}
    missing = required - set(df.columns)
    if missing:
        raise ValueError(f"OHLCV DataFrame missing columns: {missing}")

    if not isinstance(df.index, pd.DatetimeIndex):
        raise ValueError("OHLCV DataFrame must have a DatetimeIndex")

    if df.index.tz is None:
        raise ValueError("OHLCV DatetimeIndex must be UTC-aware")

    if len(df) < 50:
        raise ValueError(
            f"Insufficient data: {len(df)} bars.  "
            "At least 50 bars are required for indicator warm-up."
        )

    nan_counts = df[list(required)].isnull().sum()
    if nan_counts.any():
        raise ValueError(
            f"OHLCV DataFrame contains NaN values in columns: "
            f"{nan_counts[nan_counts > 0].to_dict()}"
        )
