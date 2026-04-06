"""
Golden dataset regression tests.

These tests enforce the core determinism guarantee:
  IDENTICAL strategy + IDENTICAL data = IDENTICAL output, always.

How golden fixtures work
------------------------
1. Run `python tests/fixtures/generate_golden.py` once to produce
   `tests/fixtures/golden_expected.json` (the reference output).
2. Commit that file to git.
3. From that point on, every CI run compares the engine output against the
   reference.  Any difference — even a single pip — causes a test failure.

When is it OK to regenerate?
------------------------------
Only when you INTENTIONALLY change engine behaviour (e.g. fix a bug that was
producing wrong trades, update an indicator formula, change vectorbt parameters).
After regenerating, the diff in `golden_expected.json` is the code review.

Tests skip gracefully if the fixture file doesn't exist yet (first-time setup).
Run the generate script to create it.
"""

import json
from datetime import datetime
from pathlib import Path

import pytest

from engine.runner import run_backtest
from engine.sir import StrategyIR

FIXTURE_PATH = Path(__file__).parent / "fixtures" / "golden_expected.json"
TOLERANCE = 1e-6   # floating-point tolerance for price/metric comparisons


@pytest.mark.skipif(
    not FIXTURE_PATH.exists(),
    reason=(
        "Golden fixture not found.  "
        "Run `python tests/fixtures/generate_golden.py` to create it."
    ),
)
class TestGoldenDataset:
    """
    Regression suite: the engine on the golden dataset must always match the
    pre-verified reference output exactly (within floating-point tolerance).
    """

    def test_trade_count_matches(self, golden_ohlcv, golden_sir_dict, golden_expected):
        sir = StrategyIR.model_validate(golden_sir_dict)
        result = run_backtest(golden_ohlcv, sir, pair="EURUSD", timeframe="1H")
        assert result.metrics["trade_count"] == golden_expected["trade_count"], (
            f"Trade count changed: got {result.metrics['trade_count']}, "
            f"expected {golden_expected['trade_count']}"
        )

    def test_sharpe_matches(self, golden_ohlcv, golden_sir_dict, golden_expected):
        sir = StrategyIR.model_validate(golden_sir_dict)
        result = run_backtest(golden_ohlcv, sir, pair="EURUSD", timeframe="1H")
        expected_sharpe = golden_expected["sharpe"]
        if expected_sharpe is None:
            assert result.metrics["sharpe"] is None
        else:
            assert abs(result.metrics["sharpe"] - expected_sharpe) < TOLERANCE, (
                f"Sharpe changed: got {result.metrics['sharpe']:.8f}, "
                f"expected {expected_sharpe:.8f}"
            )

    def test_win_rate_matches(self, golden_ohlcv, golden_sir_dict, golden_expected):
        sir = StrategyIR.model_validate(golden_sir_dict)
        result = run_backtest(golden_ohlcv, sir, pair="EURUSD", timeframe="1H")
        expected_wr = golden_expected["win_rate"]
        if expected_wr is None:
            assert result.metrics["win_rate"] is None
        else:
            assert abs(result.metrics["win_rate"] - expected_wr) < TOLERANCE

    def test_total_pnl_matches(self, golden_ohlcv, golden_sir_dict, golden_expected):
        sir = StrategyIR.model_validate(golden_sir_dict)
        result = run_backtest(golden_ohlcv, sir, pair="EURUSD", timeframe="1H")
        expected_pnl = golden_expected["total_pnl"]
        if expected_pnl is None:
            assert result.metrics["total_pnl"] is None
        else:
            assert abs(result.metrics["total_pnl"] - expected_pnl) < TOLERANCE

    def test_trade_entry_times_match(self, golden_ohlcv, golden_sir_dict, golden_expected):
        """Individual trade entry timestamps must be identical."""
        sir = StrategyIR.model_validate(golden_sir_dict)
        result = run_backtest(golden_ohlcv, sir, pair="EURUSD", timeframe="1H")
        expected_trades = golden_expected["trades"]

        assert len(result.trades) == len(expected_trades), (
            f"Trade list length changed: got {len(result.trades)}, "
            f"expected {len(expected_trades)}"
        )

        for i, (actual, expected) in enumerate(zip(result.trades, expected_trades)):
            actual_entry = actual["entry_time"]
            expected_entry = expected["entry_time"]
            if hasattr(actual_entry, "isoformat"):
                actual_entry = actual_entry.isoformat()
            assert actual_entry == expected_entry, (
                f"Trade {i} entry time changed: got {actual_entry}, "
                f"expected {expected_entry}"
            )

    def test_trade_entry_prices_match(self, golden_ohlcv, golden_sir_dict, golden_expected):
        """Trade entry prices must match within floating-point tolerance."""
        sir = StrategyIR.model_validate(golden_sir_dict)
        result = run_backtest(golden_ohlcv, sir, pair="EURUSD", timeframe="1H")
        expected_trades = golden_expected["trades"]

        for i, (actual, expected) in enumerate(zip(result.trades, expected_trades)):
            assert abs(actual["entry_price"] - expected["entry_price"]) < 1e-5, (
                f"Trade {i} entry price changed: got {actual['entry_price']:.8f}, "
                f"expected {expected['entry_price']:.8f}"
            )

    def test_determinism_across_runs(self, golden_ohlcv, golden_sir_dict):
        """Running the backtest twice on the same data must produce identical output."""
        sir = StrategyIR.model_validate(golden_sir_dict)
        result_a = run_backtest(golden_ohlcv, sir, pair="EURUSD", timeframe="1H")
        result_b = run_backtest(golden_ohlcv, sir, pair="EURUSD", timeframe="1H")

        assert result_a.metrics["trade_count"] == result_b.metrics["trade_count"]
        assert result_a.metrics["sharpe"] == result_b.metrics["sharpe"]
        assert len(result_a.trades) == len(result_b.trades)

        for i, (ta, tb) in enumerate(zip(result_a.trades, result_b.trades)):
            assert ta["entry_time"] == tb["entry_time"], f"Trade {i} entry time differs between runs"
            assert ta["entry_price"] == tb["entry_price"], f"Trade {i} entry price differs between runs"
