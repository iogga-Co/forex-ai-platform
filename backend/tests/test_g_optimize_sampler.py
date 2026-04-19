"""
Unit tests for ConfigSampler.

Tests run without a database or Redis — pure in-process logic only.
"""

import pytest
from engine.sir import StrategyIR
from tasks.g_optimize import ConfigSampler


# ---------------------------------------------------------------------------
# Shared fixtures
# ---------------------------------------------------------------------------

@pytest.fixture
def entry_cfg():
    return {
        "max_conditions": 3,
        "conditions": [
            {
                "indicator": "RSI",
                "period_min": 10, "period_max": 20, "period_step": 5,
                "operator": ">", "value_min": 40, "value_max": 70,
            },
            {
                "indicator": "EMA",
                "period_min": 8, "period_max": 50, "period_step": 10,
                "operator": "price_above",
            },
            {
                "indicator": "ADX",
                "period_min": 10, "period_max": 20, "period_step": 5,
                "operator": ">", "value_min": 20, "value_max": 30,
            },
        ],
    }


@pytest.fixture
def exit_cfg_atr():
    return {
        "exit_mode": "stops_only",
        "indicator_exits": [],
        "sl": {
            "type": "atr", "period": 14,
            "multiplier_min": 1.0, "multiplier_max": 3.0, "multiplier_step": 0.5,
        },
        "tp": {
            "type": "atr", "period": 14,
            "multiplier_min": 1.5, "multiplier_max": 5.0, "multiplier_step": 0.5,
        },
        "trailing": {"enabled": False},
        "rr_floor": 1.5,
    }


def _make_sampler(entry_cfg, exit_cfg):
    return ConfigSampler(entry_cfg, exit_cfg)


# ---------------------------------------------------------------------------
# R:R floor enforcement
# ---------------------------------------------------------------------------

class TestRRFloor:
    def test_tp_multiplier_always_gte_floor_times_sl(self, entry_cfg, exit_cfg_atr):
        sampler = _make_sampler(entry_cfg, exit_cfg_atr)
        rr_floor = exit_cfg_atr["rr_floor"]
        for _ in range(200):
            sir = sampler.sample()
            sl_mult = sir["exit_conditions"]["stop_loss"]["multiplier"]
            tp_mult = sir["exit_conditions"]["take_profit"]["multiplier"]
            assert tp_mult >= rr_floor * sl_mult - 1e-9, (
                f"R:R violated: TP={tp_mult} < floor({rr_floor}) × SL({sl_mult})"
            )

    def test_rr_floor_respected_with_strict_floor(self, entry_cfg):
        strict_exit = {
            "exit_mode": "stops_only", "indicator_exits": [],
            "sl": {"type": "atr", "period": 14, "multiplier_min": 2.0, "multiplier_max": 2.0, "multiplier_step": 0.5},
            "tp": {"type": "atr", "period": 14, "multiplier_min": 1.0, "multiplier_max": 5.0, "multiplier_step": 0.5},
            "trailing": {"enabled": False},
            "rr_floor": 2.0,
        }
        sampler = _make_sampler(entry_cfg, strict_exit)
        for _ in range(50):
            sir = sampler.sample()
            sl = sir["exit_conditions"]["stop_loss"]["multiplier"]
            tp = sir["exit_conditions"]["take_profit"]["multiplier"]
            assert tp >= 2.0 * sl - 1e-9


# ---------------------------------------------------------------------------
# Parameter ranges respected
# ---------------------------------------------------------------------------

class TestParameterRanges:
    def test_rsi_period_within_bounds(self, entry_cfg, exit_cfg_atr):
        sampler = _make_sampler(entry_cfg, exit_cfg_atr)
        rsi_cfg = next(c for c in entry_cfg["conditions"] if c["indicator"] == "RSI")
        for _ in range(200):
            sir = sampler.sample()
            for cond in sir["entry_conditions"]:
                if cond["indicator"] == "RSI":
                    assert rsi_cfg["period_min"] <= cond["period"] <= rsi_cfg["period_max"]

    def test_rsi_value_within_bounds(self, entry_cfg, exit_cfg_atr):
        sampler = _make_sampler(entry_cfg, exit_cfg_atr)
        rsi_cfg = next(c for c in entry_cfg["conditions"] if c["indicator"] == "RSI")
        for _ in range(200):
            sir = sampler.sample()
            for cond in sir["entry_conditions"]:
                if cond["indicator"] == "RSI":
                    assert rsi_cfg["value_min"] <= cond["value"] <= rsi_cfg["value_max"] + 1e-9

    def test_sl_multiplier_within_bounds(self, entry_cfg, exit_cfg_atr):
        sampler = _make_sampler(entry_cfg, exit_cfg_atr)
        sl_cfg = exit_cfg_atr["sl"]
        for _ in range(200):
            sir = sampler.sample()
            sl_mult = sir["exit_conditions"]["stop_loss"]["multiplier"]
            assert sl_cfg["multiplier_min"] <= sl_mult <= sl_cfg["multiplier_max"] + 1e-9

    def test_sampled_sirs_all_pass_pydantic_validation(self, entry_cfg, exit_cfg_atr):
        sampler = _make_sampler(entry_cfg, exit_cfg_atr)
        errors = 0
        for _ in range(100):
            try:
                sir = sampler.sample()
                StrategyIR.model_validate(sir)
            except Exception:
                errors += 1
        assert errors == 0, f"{errors}/100 samples failed StrategyIR validation"


# ---------------------------------------------------------------------------
# Exit mode applied correctly
# ---------------------------------------------------------------------------

class TestExitMode:
    def test_stops_only_produces_empty_indicator_exits(self, entry_cfg):
        exit_cfg = {
            "exit_mode": "stops_only", "indicator_exits": [],
            "sl": {"type": "atr", "period": 14, "multiplier_min": 1.5, "multiplier_max": 1.5, "multiplier_step": 0.5},
            "tp": {"type": "atr", "period": 14, "multiplier_min": 3.0, "multiplier_max": 3.0, "multiplier_step": 0.5},
            "trailing": {"enabled": False}, "rr_floor": 1.5,
        }
        sampler = _make_sampler(entry_cfg, exit_cfg)
        for _ in range(20):
            sir = sampler.sample()
            assert sir["exit_conditions"]["exit_mode"] == "stops_only"
            assert sir["exit_conditions"]["indicator_exits"] == []

    def test_first_mode_set_on_all_samples(self, entry_cfg):
        exit_cfg = {
            "exit_mode": "first",
            "indicator_exits": [
                {"indicator": "RSI", "period_min": 10, "period_max": 20, "period_step": 5,
                 "operator": "<", "value_min": 30, "value_max": 40},
            ],
            "sl": {"type": "atr", "period": 14, "multiplier_min": 1.5, "multiplier_max": 1.5, "multiplier_step": 0.5},
            "tp": {"type": "atr", "period": 14, "multiplier_min": 3.0, "multiplier_max": 3.0, "multiplier_step": 0.5},
            "trailing": {"enabled": False}, "rr_floor": 1.5,
        }
        sampler = _make_sampler(entry_cfg, exit_cfg)
        for _ in range(20):
            sir = sampler.sample()
            assert sir["exit_conditions"]["exit_mode"] == "first"

    def test_all_mode_set_on_all_samples(self, entry_cfg):
        exit_cfg = {
            "exit_mode": "all", "indicator_exits": [],
            "sl": {"type": "atr", "period": 14, "multiplier_min": 1.5, "multiplier_max": 1.5, "multiplier_step": 0.5},
            "tp": {"type": "atr", "period": 14, "multiplier_min": 3.0, "multiplier_max": 3.0, "multiplier_step": 0.5},
            "trailing": {"enabled": False}, "rr_floor": 1.5,
        }
        sampler = _make_sampler(entry_cfg, exit_cfg)
        for _ in range(20):
            sir = sampler.sample()
            assert sir["exit_conditions"]["exit_mode"] == "all"


# ---------------------------------------------------------------------------
# Max entry conditions respected
# ---------------------------------------------------------------------------

class TestMaxEntryConditions:
    def test_never_exceeds_max_conditions(self, entry_cfg, exit_cfg_atr):
        for max_n in (1, 2, 3):
            cfg = dict(entry_cfg)
            cfg["max_conditions"] = max_n
            sampler = _make_sampler(cfg, exit_cfg_atr)
            for _ in range(100):
                sir = sampler.sample()
                assert len(sir["entry_conditions"]) <= max_n, (
                    f"Got {len(sir['entry_conditions'])} conditions, max was {max_n}"
                )

    def test_always_at_least_one_condition(self, entry_cfg, exit_cfg_atr):
        sampler = _make_sampler(entry_cfg, exit_cfg_atr)
        for _ in range(100):
            sir = sampler.sample()
            assert len(sir["entry_conditions"]) >= 1

    def test_max_one_never_produces_more(self, entry_cfg, exit_cfg_atr):
        cfg = dict(entry_cfg)
        cfg["max_conditions"] = 1
        sampler = _make_sampler(cfg, exit_cfg_atr)
        for _ in range(100):
            sir = sampler.sample()
            assert len(sir["entry_conditions"]) == 1

    def test_macd_fast_always_less_than_slow(self, exit_cfg_atr):
        macd_entry_cfg = {
            "max_conditions": 1,
            "conditions": [
                {
                    "indicator": "MACD",
                    "fast_min": 8, "fast_max": 16,
                    "slow_min": 20, "slow_max": 32,
                    "signal_min": 7, "signal_max": 12,
                    "operator": ">", "value_min": 0, "value_max": 0,
                    "component": "histogram",
                },
            ],
        }
        sampler = _make_sampler(macd_entry_cfg, exit_cfg_atr)
        for _ in range(100):
            sir = sampler.sample()
            cond = sir["entry_conditions"][0]
            assert cond["fast"] < cond["slow"], (
                f"MACD fast({cond['fast']}) >= slow({cond['slow']})"
            )
