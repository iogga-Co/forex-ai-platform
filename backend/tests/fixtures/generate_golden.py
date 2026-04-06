"""
Generate golden dataset fixtures.

Run this script ONCE after the backtesting engine is implemented to create the
reference output files.  After that, the golden test in test_golden.py will
verify that future runs always produce identical output.

Usage:
    cd backend
    python tests/fixtures/generate_golden.py

IMPORTANT: Only run this script when you INTENTIONALLY change the engine behaviour.
Running it silently replaces the reference and defeats the purpose of the golden test.
You will be prompted to confirm before overwriting existing fixtures.
"""

import json
import sys
from pathlib import Path

# Allow importing from the backend root
backend_root = Path(__file__).parent.parent.parent
sys.path.insert(0, str(backend_root))

from tests.conftest import make_ohlcv  # noqa: E402
from engine.sir import StrategyIR  # noqa: E402
from engine.runner import run_backtest  # noqa: E402

FIXTURES_DIR = Path(__file__).parent
GOLDEN_EXPECTED_PATH = FIXTURES_DIR / "golden_expected.json"
GOLDEN_STRATEGY_PATH = FIXTURES_DIR / "golden_strategy.json"


def main() -> None:
    # Warn if overwriting existing fixtures
    if GOLDEN_EXPECTED_PATH.exists():
        print(f"\nWARNING: {GOLDEN_EXPECTED_PATH} already exists.")
        answer = input("Overwrite? This invalidates the current golden reference. [y/N] ")
        if answer.strip().lower() != "y":
            print("Aborted.")
            sys.exit(0)

    print("Generating golden dataset (1000 bars, seed=0) ...")
    df = make_ohlcv(n_bars=1000, seed=0, start_price=1.0800)

    with open(GOLDEN_STRATEGY_PATH) as f:
        sir_dict = json.load(f)

    sir = StrategyIR.model_validate(sir_dict)

    print("Running backtest ...")
    result = run_backtest(df=df, sir=sir, pair="EURUSD", timeframe="1H", initial_capital=100_000.0)

    expected = {
        "sir": sir_dict,
        "metrics": result.metrics,
        "trade_count": result.metrics["trade_count"],
        "sharpe": result.metrics["sharpe"],
        "sortino": result.metrics["sortino"],
        "max_dd": result.metrics["max_dd"],
        "win_rate": result.metrics["win_rate"],
        "total_pnl": result.metrics["total_pnl"],
        "trades": [
            {
                "entry_time": t["entry_time"].isoformat() if hasattr(t["entry_time"], "isoformat") else t["entry_time"],
                "exit_time": t["exit_time"].isoformat() if hasattr(t["exit_time"], "isoformat") else t["exit_time"],
                "direction": t["direction"],
                "entry_price": t["entry_price"],
                "exit_price": t["exit_price"],
                "pnl": t["pnl"],
                "r_multiple": t["r_multiple"],
            }
            for t in result.trades
        ],
    }

    with open(GOLDEN_EXPECTED_PATH, "w") as f:
        json.dump(expected, f, indent=2, default=str)

    print(f"\nGolden fixtures written to {GOLDEN_EXPECTED_PATH}")
    print(f"  Trade count : {result.metrics['trade_count']}")
    print(f"  Sharpe      : {result.metrics['sharpe']}")
    print(f"  Win rate    : {result.metrics['win_rate']}")
    print(f"  Total P&L   : {result.metrics['total_pnl']}")
    print("\nCommit the generated golden_expected.json to git.")


if __name__ == "__main__":
    main()
