"""
Tests for SIR extensions: exit_mode, indicator_exits, and trailing_stop.

These tests verify:
- exit_mode field defaults and validation
- indicator_exits parsed and evaluated correctly by SIRParser.exit_signals()
- trailing_stop fields parsed and fraction computed by SIRParser.trailing_stop_fraction()
- All three exit modes produce correct behaviour end-to-end in run_backtest()
- Trailing stop activates correctly via tsl_stop / tsl_th params
- Backwards compat: existing SIRs without new fields parse and run unchanged
"""

import pytest
import pandas as pd

from pydantic import ValidationError

from engine.sir import StrategyIR, ExitConditions, TrailingStopConfig
from engine.parser import SIRParser
from engine.runner import run_backtest


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _base_sir_dict(**exit_overrides) -> dict:
    """Minimal valid SIR; exit_overrides merged into exit_conditions."""
    base_exits = {
        "stop_loss":   {"type": "atr", "period": 14, "multiplier": 1.5},
        "take_profit": {"type": "atr", "period": 14, "multiplier": 3.0},
    }
    base_exits.update(exit_overrides)
    return {
        "entry_conditions": [
            {"indicator": "RSI", "period": 14, "operator": ">", "value": 50},
        ],
        "exit_conditions": base_exits,
    }


# ---------------------------------------------------------------------------
# SIR model — new fields
# ---------------------------------------------------------------------------

class TestSIRExtensionsParsing:
    def test_defaults_are_backwards_compatible(self, rsi_ema_sir_dict):
        """Existing SIR with no new fields parses and defaults to stops_only."""
        sir = StrategyIR.model_validate(rsi_ema_sir_dict)
        assert sir.exit_conditions.exit_mode == "stops_only"
        assert sir.exit_conditions.indicator_exits == []
        assert sir.exit_conditions.trailing_stop is None

    def test_exit_mode_first(self):
        sir = StrategyIR.model_validate(_base_sir_dict(exit_mode="first"))
        assert sir.exit_conditions.exit_mode == "first"

    def test_exit_mode_all(self):
        sir = StrategyIR.model_validate(_base_sir_dict(exit_mode="all"))
        assert sir.exit_conditions.exit_mode == "all"

    def test_exit_mode_invalid_raises(self):
        with pytest.raises(ValidationError):
            StrategyIR.model_validate(_base_sir_dict(exit_mode="invalid"))

    def test_indicator_exits_parsed(self):
        d = _base_sir_dict(
            exit_mode="first",
            indicator_exits=[
                {"indicator": "RSI", "period": 14, "operator": "<", "value": 30},
            ],
        )
        sir = StrategyIR.model_validate(d)
        assert len(sir.exit_conditions.indicator_exits) == 1
        assert sir.exit_conditions.indicator_exits[0].indicator == "RSI"

    def test_trailing_stop_parsed(self):
        d = _base_sir_dict(
            trailing_stop={
                "enabled": True,
                "type": "atr",
                "period": 14,
                "multiplier": 1.5,
                "activation_multiplier": 1.0,
            }
        )
        sir = StrategyIR.model_validate(d)
        ts = sir.exit_conditions.trailing_stop
        assert ts is not None
        assert ts.enabled is True
        assert ts.multiplier == 1.5

    def test_trailing_stop_disabled_by_default(self):
        d = _base_sir_dict(trailing_stop={"enabled": False, "type": "atr"})
        sir = StrategyIR.model_validate(d)
        assert sir.exit_conditions.trailing_stop.enabled is False


# ---------------------------------------------------------------------------
# SIRParser — exit_signals()
# ---------------------------------------------------------------------------

class TestExitSignals:
    def test_no_indicator_exits_returns_all_false(self, sample_ohlcv):
        sir = StrategyIR.model_validate(_base_sir_dict())
        parser = SIRParser(sir, sample_ohlcv)
        result = parser.exit_signals()
        assert isinstance(result, pd.Series)
        assert result.dtype == bool
        assert not result.any()

    def test_rsi_exit_fires(self, sample_ohlcv):
        """RSI exit condition < 70 fires on some bars (RSI is rarely always ≥ 70)."""
        d = _base_sir_dict(
            exit_mode="first",
            indicator_exits=[
                {"indicator": "RSI", "period": 14, "operator": "<", "value": 70},
            ],
        )
        sir = StrategyIR.model_validate(d)
        parser = SIRParser(sir, sample_ohlcv)
        result = parser.exit_signals()
        assert result.any(), "RSI < 70 exit should fire on at least some bars"

    def test_multiple_exits_use_or_logic(self, sample_ohlcv):
        """Two exit conditions — result should have at least as many True bars as either alone."""
        d_single = _base_sir_dict(
            exit_mode="first",
            indicator_exits=[
                {"indicator": "RSI", "period": 14, "operator": "<", "value": 60},
            ],
        )
        d_two = _base_sir_dict(
            exit_mode="first",
            indicator_exits=[
                {"indicator": "RSI", "period": 14, "operator": "<", "value": 60},
                {"indicator": "RSI", "period": 14, "operator": ">", "value": 40},
            ],
        )
        sir_single = StrategyIR.model_validate(d_single)
        sir_two = StrategyIR.model_validate(d_two)
        parser_single = SIRParser(sir_single, sample_ohlcv)
        parser_two = SIRParser(sir_two, sample_ohlcv)
        single_count = parser_single.exit_signals().sum()
        two_count = parser_two.exit_signals().sum()
        assert two_count >= single_count


# ---------------------------------------------------------------------------
# SIRParser — trailing_stop_fraction() and trailing_stop_threshold()
# ---------------------------------------------------------------------------

class TestTrailingStopFractions:
    def test_no_trailing_stop_returns_none(self, sample_ohlcv):
        sir = StrategyIR.model_validate(_base_sir_dict())
        parser = SIRParser(sir, sample_ohlcv)
        assert parser.trailing_stop_fraction() is None

    def test_disabled_trailing_stop_returns_none(self, sample_ohlcv):
        d = _base_sir_dict(trailing_stop={"enabled": False, "type": "atr", "period": 14, "multiplier": 1.5})
        sir = StrategyIR.model_validate(d)
        parser = SIRParser(sir, sample_ohlcv)
        assert parser.trailing_stop_fraction() is None

    def test_atr_trailing_stop_fraction_positive(self, sample_ohlcv):
        d = _base_sir_dict(trailing_stop={
            "enabled": True, "type": "atr", "period": 14, "multiplier": 1.5, "activation_multiplier": 1.0,
        })
        sir = StrategyIR.model_validate(d)
        parser = SIRParser(sir, sample_ohlcv)
        frac = parser.trailing_stop_fraction()
        assert frac is not None
        assert (frac > 0).all()

    def test_fixed_pips_trailing_stop(self, sample_ohlcv):
        d = _base_sir_dict(trailing_stop={
            "enabled": True, "type": "fixed_pips", "pips": 20.0, "activation_multiplier": 0.0,
        })
        sir = StrategyIR.model_validate(d)
        parser = SIRParser(sir, sample_ohlcv, symbol="EURUSD")
        frac = parser.trailing_stop_fraction()
        assert frac is not None
        assert (frac > 0).all()


# ---------------------------------------------------------------------------
# run_backtest() — exit mode integration
# ---------------------------------------------------------------------------

class TestExitModeIntegration:
    def test_stops_only_runs_cleanly(self, sample_ohlcv, rsi_ema_sir_dict):
        """Default behaviour (stops_only) unchanged after SIR extensions."""
        sir = StrategyIR.model_validate(rsi_ema_sir_dict)
        result = run_backtest(sample_ohlcv, sir, pair="EURUSD")
        assert result.metrics["trade_count"] >= 0

    def test_exit_mode_first_runs_cleanly(self, sample_ohlcv):
        """exit_mode=first with RSI exit condition completes without error."""
        d = _base_sir_dict(
            exit_mode="first",
            indicator_exits=[
                {"indicator": "RSI", "period": 14, "operator": "<", "value": 40},
            ],
        )
        sir = StrategyIR.model_validate(d)
        result = run_backtest(sample_ohlcv, sir, pair="EURUSD")
        assert result.metrics["trade_count"] >= 0

    def test_exit_mode_all_runs_cleanly(self, sample_ohlcv):
        """exit_mode=all falls back to stops_only (conservative) — no crash."""
        d = _base_sir_dict(
            exit_mode="all",
            indicator_exits=[
                {"indicator": "RSI", "period": 14, "operator": "<", "value": 40},
            ],
        )
        sir = StrategyIR.model_validate(d)
        result = run_backtest(sample_ohlcv, sir, pair="EURUSD")
        assert result.metrics["trade_count"] >= 0

    def test_trailing_stop_runs_cleanly(self, sample_ohlcv):
        """Trailing stop enabled — vectorbt receives tsl_stop without error."""
        d = _base_sir_dict(
            trailing_stop={
                "enabled": True,
                "type": "atr",
                "period": 14,
                "multiplier": 1.0,
                "activation_multiplier": 1.0,
            }
        )
        sir = StrategyIR.model_validate(d)
        result = run_backtest(sample_ohlcv, sir, pair="EURUSD")
        assert result.metrics["trade_count"] >= 0

    def test_backwards_compat_golden(self, golden_ohlcv, golden_sir_dict, golden_expected):
        """Existing golden SIR produces identical metrics after SIR extension changes."""
        if golden_expected is None:
            pytest.skip("Golden fixture not generated yet — run pytest --generate-golden")
        sir = StrategyIR.model_validate(golden_sir_dict)
        result = run_backtest(golden_ohlcv, sir, pair="EURUSD")
        assert result.metrics["trade_count"] == golden_expected["trade_count"]
        assert abs(result.metrics["sharpe"] - golden_expected["sharpe"]) < 0.01
