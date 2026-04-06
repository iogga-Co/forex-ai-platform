"""
Unit tests for the SIR model validation and the SIRParser.

Tests do NOT require a running database or Redis.
"""

import pytest

from pydantic import ValidationError

from engine.sir import StrategyIR
from engine.parser import SIRParser


# ---------------------------------------------------------------------------
# StrategyIR validation
# ---------------------------------------------------------------------------

class TestStrategyIRValidation:
    def test_valid_sir_parses(self, rsi_ema_sir_dict):
        sir = StrategyIR.model_validate(rsi_ema_sir_dict)
        assert len(sir.entry_conditions) == 2
        assert sir.exit_conditions.stop_loss.type == "atr"

    def test_missing_entry_conditions_raises(self, rsi_ema_sir_dict):
        d = dict(rsi_ema_sir_dict)
        d["entry_conditions"] = []
        with pytest.raises(ValidationError):
            StrategyIR.model_validate(d)

    def test_price_operator_with_dimensionless_indicator_raises(self, rsi_ema_sir_dict):
        d = dict(rsi_ema_sir_dict)
        d["entry_conditions"] = [
            {"indicator": "RSI", "period": 14, "operator": "price_above"},
        ]
        with pytest.raises(ValidationError):
            StrategyIR.model_validate(d)

    def test_threshold_operator_without_value_raises(self, rsi_ema_sir_dict):
        d = dict(rsi_ema_sir_dict)
        d["entry_conditions"] = [
            {"indicator": "RSI", "period": 14, "operator": ">"},
        ]
        with pytest.raises(ValidationError):
            StrategyIR.model_validate(d)

    def test_invalid_operator_raises(self, rsi_ema_sir_dict):
        d = dict(rsi_ema_sir_dict)
        d["entry_conditions"] = [
            {"indicator": "RSI", "period": 14, "operator": "BETWEEN", "value": 50},
        ]
        with pytest.raises(ValidationError):
            StrategyIR.model_validate(d)

    def test_atr_stop_without_period_raises(self, rsi_ema_sir_dict):
        d = dict(rsi_ema_sir_dict)
        d["exit_conditions"] = {
            "stop_loss": {"type": "atr", "multiplier": 1.5},   # missing period
            "take_profit": {"type": "atr", "period": 14, "multiplier": 3.0},
        }
        with pytest.raises(ValidationError):
            StrategyIR.model_validate(d)

    def test_risk_pct_out_of_range_raises(self, rsi_ema_sir_dict):
        d = dict(rsi_ema_sir_dict)
        d["position_sizing"] = {"risk_per_trade_pct": 15.0, "max_size_units": 10000}
        with pytest.raises(ValidationError):
            StrategyIR.model_validate(d)

    def test_default_filters(self, rsi_ema_sir_dict):
        d = dict(rsi_ema_sir_dict)
        del d["filters"]
        sir = StrategyIR.model_validate(d)
        assert sir.filters.session == "all"
        assert sir.filters.exclude_days == []

    def test_macd_all_components_valid(self):
        for component in ("line", "signal", "histogram"):
            sir = StrategyIR.model_validate({
                "entry_conditions": [
                    {"indicator": "MACD", "fast": 12, "slow": 26,
                     "signal_period": 9, "component": component,
                     "operator": ">", "value": 0},
                ],
                "exit_conditions": {
                    "stop_loss": {"type": "atr", "period": 14, "multiplier": 1.5},
                    "take_profit": {"type": "atr", "period": 14, "multiplier": 3.0},
                },
                "position_sizing": {"risk_per_trade_pct": 1.0, "max_size_units": 10000},
            })
            assert sir.entry_conditions[0].component == component


# ---------------------------------------------------------------------------
# SIRParser — signal array generation
# ---------------------------------------------------------------------------

class TestSIRParser:
    def test_entry_signals_boolean(self, sample_ohlcv, rsi_ema_sir_dict):
        sir = StrategyIR.model_validate(rsi_ema_sir_dict)
        parser = SIRParser(sir, sample_ohlcv)
        signals = parser.entry_signals()
        assert signals.dtype == bool
        assert len(signals) == len(sample_ohlcv)

    def test_entry_signals_same_index(self, sample_ohlcv, rsi_ema_sir_dict):
        sir = StrategyIR.model_validate(rsi_ema_sir_dict)
        parser = SIRParser(sir, sample_ohlcv)
        signals = parser.entry_signals()
        assert signals.index.equals(sample_ohlcv.index)

    def test_no_nan_in_entry_signals(self, sample_ohlcv, rsi_ema_sir_dict):
        sir = StrategyIR.model_validate(rsi_ema_sir_dict)
        parser = SIRParser(sir, sample_ohlcv)
        signals = parser.entry_signals()
        assert not signals.isna().any()

    def test_sl_fractions_positive(self, sample_ohlcv, rsi_ema_sir_dict):
        sir = StrategyIR.model_validate(rsi_ema_sir_dict)
        parser = SIRParser(sir, sample_ohlcv)
        sl = parser.sl_fractions()
        assert (sl.dropna() > 0).all()

    def test_tp_gt_sl(self, sample_ohlcv, rsi_ema_sir_dict):
        """Take-profit multiplier 3.0 > stop-loss multiplier 1.5 → TP fraction > SL fraction."""
        sir = StrategyIR.model_validate(rsi_ema_sir_dict)
        parser = SIRParser(sir, sample_ohlcv)
        # Skip the ATR warm-up period where the 0.01 fallback makes sl == tp
        sl = parser.sl_fractions().iloc[50:]
        tp = parser.tp_fractions().iloc[50:]
        assert (tp > sl).all()

    def test_filter_mask_all_session(self, sample_ohlcv, rsi_ema_sir_dict):
        sir = StrategyIR.model_validate(rsi_ema_sir_dict)
        parser = SIRParser(sir, sample_ohlcv)
        mask = parser.filter_mask()
        # "all" session with no excluded days → all True
        assert mask.all()

    def test_filter_mask_london_only(self, sample_ohlcv, london_filter_sir_dict):
        sir = StrategyIR.model_validate(london_filter_sir_dict)
        parser = SIRParser(sir, sample_ohlcv)
        mask = parser.filter_mask()
        # Only London hours (7–11 UTC) and non-Mondays should be True
        assert not mask.all()
        assert mask.any()
        # All True bars should be in London hours
        london_bars = sample_ohlcv.index[mask]
        assert (london_bars.hour >= 7).all()
        assert (london_bars.hour < 12).all()

    def test_filter_mask_excludes_monday(self, sample_ohlcv, london_filter_sir_dict):
        sir = StrategyIR.model_validate(london_filter_sir_dict)
        parser = SIRParser(sir, sample_ohlcv)
        mask = parser.filter_mask()
        true_bars = sample_ohlcv.index[mask]
        # No Monday bars in the mask
        assert (true_bars.weekday != 0).all()

    def test_crossed_above_operator(self, sample_ohlcv):
        """crossed_above fires only on the bar where the indicator crosses the threshold."""
        sir_dict = {
            "entry_conditions": [
                {"indicator": "RSI", "period": 14, "operator": "crossed_above", "value": 50},
            ],
            "exit_conditions": {
                "stop_loss": {"type": "atr", "period": 14, "multiplier": 1.5},
                "take_profit": {"type": "atr", "period": 14, "multiplier": 3.0},
            },
            "position_sizing": {"risk_per_trade_pct": 1.0, "max_size_units": 10000},
        }
        sir = StrategyIR.model_validate(sir_dict)
        parser = SIRParser(sir, sample_ohlcv)
        signals = parser.entry_signals()

        # crossed_above fires fewer times than plain ">"
        rsi_gt = StrategyIR.model_validate({
            **sir_dict,
            "entry_conditions": [
                {"indicator": "RSI", "period": 14, "operator": ">", "value": 50}
            ],
        })
        gt_signals = SIRParser(rsi_gt, sample_ohlcv).entry_signals()
        assert signals.sum() < gt_signals.sum()

    def test_indicator_cache_reuse(self, sample_ohlcv):
        """SIRParser should compute each indicator only once."""
        sir_dict = {
            "entry_conditions": [
                {"indicator": "RSI", "period": 14, "operator": ">", "value": 50},
                {"indicator": "RSI", "period": 14, "operator": "<", "value": 70},
            ],
            "exit_conditions": {
                "stop_loss": {"type": "atr", "period": 14, "multiplier": 1.5},
                "take_profit": {"type": "atr", "period": 14, "multiplier": 3.0},
            },
            "position_sizing": {"risk_per_trade_pct": 1.0, "max_size_units": 10000},
        }
        sir = StrategyIR.model_validate(sir_dict)
        parser = SIRParser(sir, sample_ohlcv)
        parser.entry_signals()
        # RSI_14 should appear exactly once in the cache
        assert "RSI_14" in parser._indicator_cache
        assert len([k for k in parser._indicator_cache if k.startswith("RSI_14")]) == 1

    def test_position_sizes_bounded(self, sample_ohlcv, rsi_ema_sir_dict):
        sir = StrategyIR.model_validate(rsi_ema_sir_dict)
        parser = SIRParser(sir, sample_ohlcv)
        sizes = parser.position_sizes(account_equity=100_000.0)
        assert (sizes <= sir.position_sizing.max_size_units).all()
        assert (sizes >= 1.0).all()
