"""
Extract scalar performance metrics and per-trade records from a vectorbt Portfolio.

All metric functions return floats (not numpy scalars) for JSON serialisation.
NaN/infinite values are replaced with None to represent "not calculable".
"""

import logging
import math

import pandas as pd

logger = logging.getLogger(__name__)


def _safe_float(value) -> float | None:
    """Convert a numpy scalar or float to Python float; return None for NaN/Inf."""
    try:
        v = float(value)
        return None if (math.isnan(v) or math.isinf(v)) else v
    except (TypeError, ValueError):
        return None


def extract_metrics(portfolio) -> dict:
    """
    Extract aggregate performance metrics from a vectorbt Portfolio.

    Returns a dict with keys matching the backtest_runs DB schema:
    sharpe, sortino, max_dd, win_rate, avg_r, trade_count, total_pnl
    """
    trades = portfolio.trades

    trade_count = int(trades.count())
    if trade_count == 0:
        return {
            "sharpe": None,
            "sortino": None,
            "max_dd": None,
            "win_rate": None,
            "avg_r": None,
            "trade_count": 0,
            "total_pnl": 0.0,
        }

    # vectorbt returns Sharpe annualised using the portfolio's freq parameter
    sharpe = _safe_float(portfolio.sharpe_ratio())
    sortino = _safe_float(portfolio.sortino_ratio())
    max_dd = _safe_float(portfolio.max_drawdown())

    records = trades.records_readable
    win_rate = _safe_float(records["Return"].gt(0).mean())
    total_pnl = _safe_float(portfolio.total_profit())

    # R-multiple: pnl / initial_risk per trade
    # Initial risk = entry_price * sl_fraction * size (stored in signal_context by runner)
    # For now compute avg_r as mean of (pnl / |pnl| * R) where R is implicit
    # This is approximated as (return / mean_loss) for losing trades
    avg_r = _safe_float(_compute_avg_r(records))

    return {
        "sharpe": sharpe,
        "sortino": sortino,
        "max_dd": max_dd,
        "win_rate": win_rate,
        "avg_r": avg_r,
        "trade_count": trade_count,
        "total_pnl": total_pnl,
    }


def _compute_avg_r(records: pd.DataFrame) -> float:
    """
    Compute average R-multiple from trade records.

    R = pnl / avg_losing_trade_pnl (absolute)
    This is a simplified proxy; Phase 2+ will store exact initial_risk in signal_context.
    """
    pnl_col = "PnL" if "PnL" in records.columns else "Return"
    pnl = records[pnl_col]

    losers = pnl[pnl < 0]
    if losers.empty:
        return float("nan")

    avg_loss = losers.abs().mean()
    if avg_loss == 0:
        return float("nan")

    avg_r = (pnl / avg_loss).mean()
    return float(avg_r)


def extract_trades(
    portfolio,
    df: pd.DataFrame,
    sl_fracs: pd.Series,
) -> list[dict]:
    """
    Build the list of trade dicts for bulk insertion into the `trades` table.

    MAE and MFE are computed from the raw OHLCV data for each trade's holding
    period, giving the true maximum adverse/favorable price excursion.
    """
    records_readable = portfolio.trades.records_readable
    if records_readable.empty:
        return []

    # Use raw integer positions from portfolio.trades.records to avoid
    # timezone-mismatch KeyErrors when matching timestamps via get_loc.
    raw_records = portfolio.trades.records

    trade_list: list[dict] = []
    high = df["high"]
    low = df["low"]

    for i, (_, row) in enumerate(records_readable.iterrows()):
        entry_idx = int(raw_records.iloc[i]["entry_idx"])
        exit_idx = int(raw_records.iloc[i]["exit_idx"])

        entry_time = df.index[entry_idx]
        exit_time = df.index[exit_idx]
        entry_price = float(row["Avg Entry Price"])
        exit_price = float(row["Avg Exit Price"])
        direction = "long" if row["Direction"] == "Long" else "short"
        pnl = float(row["PnL"])
        size = float(row["Size"])

        # Compute MAE and MFE over the holding period
        holding_high = high.iloc[entry_idx : exit_idx + 1]
        holding_low = low.iloc[entry_idx : exit_idx + 1]

        if direction == "long":
            mae = float(entry_price - holding_low.min())   # max adverse excursion (price units)
            mfe = float(holding_high.max() - entry_price)  # max favorable excursion
        else:
            mae = float(holding_high.max() - entry_price)
            mfe = float(entry_price - holding_low.min())

        # R-multiple: pnl / initial_risk
        sl_frac = float(sl_fracs.iloc[entry_idx])
        initial_risk = entry_price * sl_frac * size
        r_multiple = float(pnl / initial_risk) if initial_risk != 0 else 0.0

        trade_list.append({
            "entry_time": entry_time.to_pydatetime(),
            "exit_time": exit_time.to_pydatetime(),
            "direction": direction,
            "entry_price": entry_price,
            "exit_price": exit_price,
            "pnl": pnl,
            "r_multiple": r_multiple,
            "mae": max(mae, 0.0),
            "mfe": max(mfe, 0.0),
            "signal_context": {
                "size": size,
                "sl_fraction": sl_frac,
            },
        })

    return trade_list
