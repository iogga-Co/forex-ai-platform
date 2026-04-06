"""
Shared pytest fixtures for Phase 1 tests.

All fixtures that produce DataFrames use a fixed numpy random seed (42) so
that test results are fully reproducible across machines and Python versions.
"""

import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

FIXTURES_DIR = Path(__file__).parent / "fixtures"


# ---------------------------------------------------------------------------
# Synthetic OHLCV data
# ---------------------------------------------------------------------------

def make_ohlcv(
    n_bars: int = 500,
    seed: int = 42,
    start: datetime | None = None,
    freq: str = "1h",
    start_price: float = 1.0800,
    vol: float = 0.0005,  # ~5 pip hourly volatility
) -> pd.DataFrame:
    """
    Generate a deterministic synthetic OHLCV DataFrame.

    The close prices follow a random walk with the given per-bar volatility.
    High/low are derived from close ± a random fraction of the bar's move.
    Open is the previous close (no overnight gaps).
    """
    rng = np.random.default_rng(seed)

    if start is None:
        start = datetime(2022, 1, 3, 0, 0, tzinfo=timezone.utc)

    freq_map = {"1h": timedelta(hours=1), "1D": timedelta(days=1), "1m": timedelta(minutes=1)}
    bar_delta = freq_map.get(freq, timedelta(hours=1))
    timestamps = [start + bar_delta * i for i in range(n_bars)]

    # Geometric random walk for close prices
    returns = rng.normal(0, vol, n_bars)
    closes = np.cumprod(1 + returns) * start_price

    # Open = previous close (gap-free)
    opens = np.roll(closes, 1)
    opens[0] = start_price

    # High and low: expand close by a random fraction of the bar move
    bar_range = rng.uniform(0.0002, 0.0012, n_bars)  # 2–12 pip range
    highs = np.maximum(opens, closes) + bar_range * rng.uniform(0, 1, n_bars)
    lows = np.minimum(opens, closes) - bar_range * rng.uniform(0, 1, n_bars)
    lows = np.maximum(lows, 0.0001)  # prices can't go negative

    index = pd.DatetimeIndex(timestamps, tz=timezone.utc)
    return pd.DataFrame(
        {"open": opens, "high": highs, "low": lows, "close": closes, "volume": 1000.0},
        index=index,
    ).astype("float64")


@pytest.fixture
def sample_ohlcv() -> pd.DataFrame:
    """500 bars of synthetic EURUSD 1H data, seed=42."""
    return make_ohlcv(n_bars=500, seed=42)


@pytest.fixture
def small_ohlcv() -> pd.DataFrame:
    """100 bars for fast unit tests."""
    return make_ohlcv(n_bars=100, seed=42)


# ---------------------------------------------------------------------------
# Sample SIR documents
# ---------------------------------------------------------------------------

@pytest.fixture
def rsi_ema_sir_dict() -> dict:
    """
    Simple RSI + EMA strategy — used across unit tests and golden dataset.

    Entry: RSI(14) > 50  AND  price > EMA(20)
    Exit:  ATR(14) × 1.5 stop-loss,  ATR(14) × 3.0 take-profit
    """
    return {
        "entry_conditions": [
            {"indicator": "RSI", "period": 14, "operator": ">", "value": 50},
            {"indicator": "EMA", "period": 20, "operator": "price_above"},
        ],
        "exit_conditions": {
            "stop_loss":   {"type": "atr", "period": 14, "multiplier": 1.5},
            "take_profit": {"type": "atr", "period": 14, "multiplier": 3.0},
        },
        "filters": {
            "exclude_days": [],
            "session": "all",
        },
        "position_sizing": {
            "risk_per_trade_pct": 1.0,
            "max_size_units": 10000,
        },
    }


@pytest.fixture
def london_filter_sir_dict() -> dict:
    """Strategy with London session and Monday exclusion filters."""
    return {
        "entry_conditions": [
            {"indicator": "RSI", "period": 14, "operator": ">", "value": 50},
        ],
        "exit_conditions": {
            "stop_loss":   {"type": "atr", "period": 14, "multiplier": 1.5},
            "take_profit": {"type": "atr", "period": 14, "multiplier": 3.0},
        },
        "filters": {
            "exclude_days": ["Monday"],
            "session": "london_open",
        },
        "position_sizing": {
            "risk_per_trade_pct": 1.0,
            "max_size_units": 10000,
        },
    }


# ---------------------------------------------------------------------------
# Golden dataset fixtures
# ---------------------------------------------------------------------------

@pytest.fixture
def golden_ohlcv() -> pd.DataFrame:
    """
    The golden dataset — 1,000 bars of synthetic OHLCV with seed=0.

    This is the canonical input for golden dataset regression tests.
    The data is generated deterministically from seed=0 so it never changes.
    """
    return make_ohlcv(n_bars=1000, seed=0, start_price=1.0800)


@pytest.fixture
def golden_sir_dict() -> dict:
    """The golden strategy — read from the committed fixture file."""
    fixture_path = FIXTURES_DIR / "golden_strategy.json"
    with open(fixture_path) as f:
        return json.load(f)


@pytest.fixture
def golden_expected() -> dict | None:
    """
    The pre-computed expected output for the golden dataset run.

    Returns None if the file doesn't exist yet (first-time setup).
    Run `pytest --generate-golden` to create it.
    """
    fixture_path = FIXTURES_DIR / "golden_expected.json"
    if not fixture_path.exists():
        return None
    with open(fixture_path) as f:
        return json.load(f)
