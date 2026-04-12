"""
Unit tests for the Optimization tab backend.

Tests are structured in three groups:

1. optimization_agent — apply_tool_call and build_extra_context (pure logic, no I/O)
2. optimization_agent — analyze_and_mutate with a mocked Anthropic client
3. optimization router — HTTP endpoints with mocked DB and Celery

All tests run without a real database, Redis, or Anthropic API key.
"""

import copy
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest

# ---------------------------------------------------------------------------
# Fixtures — minimal valid StrategyIR dicts
# ---------------------------------------------------------------------------

MINIMAL_IR = {
    "version": 1,
    "direction": "long",
    "entry_conditions": [
        {"indicator": "RSI", "period": 14, "operator": ">", "value": 30},
        {"indicator": "SMA", "period": 50, "operator": "price_above"},
    ],
    "exit_conditions": {
        "stop_loss": {"type": "atr", "period": 14, "multiplier": 2.0},
        "take_profit": {"type": "atr", "period": 14, "multiplier": 3.0},
    },
    "position_sizing": {"risk_per_trade_pct": 1.0},
    "metadata": {"name": "Test Strategy", "description": "For unit tests"},
}


# ===========================================================================
# Group 1 — apply_tool_call (pure unit tests)
# ===========================================================================

class TestApplyToolCall:
    def _apply(self, tool_name: str, tool_input: dict) -> dict:
        from ai.optimization_agent import apply_tool_call
        return apply_tool_call(copy.deepcopy(MINIMAL_IR), tool_name, tool_input)

    def test_set_period_updates_condition(self):
        result = self._apply("set_period", {"condition_index": 0, "period": 20})
        assert result["entry_conditions"][0]["period"] == 20

    def test_set_period_clamps_minimum(self):
        result = self._apply("set_period", {"condition_index": 0, "period": 0})
        assert result["entry_conditions"][0]["period"] == 2

    def test_set_period_clamps_maximum(self):
        result = self._apply("set_period", {"condition_index": 0, "period": 9999})
        assert result["entry_conditions"][0]["period"] == 500

    def test_set_period_out_of_range_index_is_noop(self):
        original = copy.deepcopy(MINIMAL_IR)
        result = self._apply("set_period", {"condition_index": 99, "period": 20})
        assert result["entry_conditions"] == original["entry_conditions"]

    def test_set_threshold_updates_value(self):
        result = self._apply("set_threshold", {"condition_index": 0, "value": 25.0})
        assert result["entry_conditions"][0]["value"] == 25.0

    def test_set_operator_updates_operator(self):
        result = self._apply("set_operator", {"condition_index": 0, "operator": "<"})
        assert result["entry_conditions"][0]["operator"] == "<"

    def test_set_operator_price_above_removes_value(self):
        """price_above / price_below conditions must not have a value field."""
        result = self._apply("set_operator", {"condition_index": 0, "operator": "price_above"})
        assert result["entry_conditions"][0]["operator"] == "price_above"
        assert "value" not in result["entry_conditions"][0]

    def test_set_exit_multiplier_stop_loss(self):
        result = self._apply("set_exit_multiplier", {"side": "stop_loss", "multiplier": 1.5})
        assert result["exit_conditions"]["stop_loss"]["multiplier"] == 1.5

    def test_set_exit_multiplier_clamps_min(self):
        result = self._apply("set_exit_multiplier", {"side": "stop_loss", "multiplier": 0.0})
        assert result["exit_conditions"]["stop_loss"]["multiplier"] == 0.1

    def test_set_exit_multiplier_clamps_max(self):
        result = self._apply("set_exit_multiplier", {"side": "take_profit", "multiplier": 999.0})
        assert result["exit_conditions"]["take_profit"]["multiplier"] == 10.0

    def test_set_exit_period(self):
        result = self._apply("set_exit_period", {"side": "stop_loss", "period": 20})
        assert result["exit_conditions"]["stop_loss"]["period"] == 20

    def test_set_risk_per_trade(self):
        result = self._apply("set_risk_per_trade", {"risk_pct": 2.0})
        assert result["position_sizing"]["risk_per_trade_pct"] == 2.0

    def test_set_risk_per_trade_clamps(self):
        result = self._apply("set_risk_per_trade", {"risk_pct": 100.0})
        assert result["position_sizing"]["risk_per_trade_pct"] == 5.0

    def test_original_ir_is_not_mutated(self):
        original = copy.deepcopy(MINIMAL_IR)
        from ai.optimization_agent import apply_tool_call
        apply_tool_call(original, "set_period", {"condition_index": 0, "period": 99})
        assert original["entry_conditions"][0]["period"] == 14

    def test_unknown_tool_is_noop(self):
        original = copy.deepcopy(MINIMAL_IR)
        result = self._apply("nonexistent_tool", {})
        assert result["entry_conditions"] == original["entry_conditions"]


# ===========================================================================
# Group 2 — build_extra_context
# ===========================================================================

class TestBuildExtraContext:
    def _ctx(self, **kwargs):
        from ai.optimization_agent import build_extra_context
        return build_extra_context(**kwargs)

    def test_zero_trades_returns_warning(self):
        msg = self._ctx(trade_count=0, prev_trade_count=5, sharpe=0.0, prev_sharpe=1.0)
        assert "0 trades" in msg
        assert msg  # non-empty

    def test_unchanged_results_returns_warning(self):
        msg = self._ctx(trade_count=10, prev_trade_count=10, sharpe=1.234, prev_sharpe=1.234)
        assert "identical" in msg.lower() or "unchanged" in msg.lower() or "no measurable" in msg.lower()

    def test_normal_results_returns_empty_string(self):
        msg = self._ctx(trade_count=15, prev_trade_count=10, sharpe=1.5, prev_sharpe=1.0)
        assert msg == ""

    def test_first_iteration_with_zero_prev_not_flagged_as_unchanged(self):
        # First iteration: prev_trade_count=0, any trade count is fine
        msg = self._ctx(trade_count=12, prev_trade_count=0, sharpe=0.9, prev_sharpe=0.0)
        assert "identical" not in msg.lower()


# ===========================================================================
# Group 3 — analyze_and_mutate with mocked Anthropic client
# ===========================================================================

def _make_tool_use_block(name: str, input_dict: dict) -> SimpleNamespace:
    return SimpleNamespace(type="tool_use", name=name, input=input_dict)


def _make_text_block(text: str) -> SimpleNamespace:
    return SimpleNamespace(type="text", text=text)


def _make_response(content: list) -> SimpleNamespace:
    return SimpleNamespace(content=content)


class TestAnalyzeAndMutate:
    """Smoke tests for analyze_and_mutate with a mocked Anthropic messages.create."""

    METRICS = {
        "sharpe": 0.8,
        "win_rate": 0.45,
        "max_dd": 0.12,
        "trade_count": 30,
        "total_pnl": 2500.0,
    }

    def _call(self, mock_response):
        with patch("ai.optimization_agent._get_client") as mock_get_client:
            mock_client = MagicMock()
            mock_client.messages.create.return_value = mock_response
            mock_get_client.return_value = mock_client

            from ai.optimization_agent import analyze_and_mutate
            return analyze_and_mutate(
                current_ir=copy.deepcopy(MINIMAL_IR),
                metrics=self.METRICS,
                trades_summary=[],
                iteration_history=[],
                user_system_prompt="Maximize Sharpe",
                user_prompt="",
                conversation=[],
                extra_context="",
            )

    def test_returns_unchanged_ir_when_no_tool_calls(self):
        response = _make_response([_make_text_block("Looks fine already.")])
        updated_ir, analysis, changes = self._call(response)
        assert updated_ir == MINIMAL_IR
        assert changes == "no changes"
        assert "Looks fine already" in analysis

    def test_applies_single_valid_tool_call(self):
        response = _make_response([
            _make_text_block("RSI period is too short, widening."),
            _make_tool_use_block("set_period", {"condition_index": 0, "period": 21}),
        ])
        updated_ir, analysis, changes = self._call(response)
        assert updated_ir["entry_conditions"][0]["period"] == 21
        assert "set_period" in changes

    def test_applies_multiple_tool_calls_sequentially(self):
        response = _make_response([
            _make_text_block("Adjusting RSI and exit."),
            _make_tool_use_block("set_period", {"condition_index": 0, "period": 21}),
            _make_tool_use_block("set_exit_multiplier", {"side": "stop_loss", "multiplier": 1.5}),
        ])
        updated_ir, analysis, changes = self._call(response)
        assert updated_ir["entry_conditions"][0]["period"] == 21
        assert updated_ir["exit_conditions"]["stop_loss"]["multiplier"] == 1.5
        assert "set_period" in changes
        assert "set_exit_multiplier" in changes

    def test_falls_back_to_current_ir_on_api_error(self):
        with patch("ai.optimization_agent._get_client") as mock_get_client:
            mock_client = MagicMock()
            mock_client.messages.create.side_effect = Exception("API timeout")
            mock_get_client.return_value = mock_client

            from ai.optimization_agent import analyze_and_mutate
            updated_ir, analysis, changes = analyze_and_mutate(
                current_ir=copy.deepcopy(MINIMAL_IR),
                metrics=self.METRICS,
                trades_summary=[],
                iteration_history=[],
                user_system_prompt="",
                user_prompt="",
                conversation=[],
            )

        assert updated_ir == MINIMAL_IR
        assert "error" in analysis.lower() or "timeout" in analysis.lower()
        assert changes == "no changes"


# ===========================================================================
# Group 4 — optimization router (HTTP)
# ===========================================================================

class TestOptimizationRouter:
    """
    Integration-style tests for /api/optimization/* endpoints.

    Uses FastAPI TestClient with app.dependency_overrides to bypass JWT auth
    and inject a mock DB pool.
    """

    @pytest.fixture(autouse=True)
    def _setup(self):
        from fastapi.testclient import TestClient
        from unittest.mock import AsyncMock, MagicMock
        import uuid
        import datetime

        from main import app
        from core.auth import get_current_user, TokenData
        from core.db import get_pool

        self.run_id = str(uuid.uuid4())
        self.user_sub = "operator"
        self.strategy_id = str(uuid.uuid4())

        self.fake_run = {
            "id": self.run_id,
            "status": "pending",
            "pair": "EURUSD",
            "timeframe": "1H",
            "period_start": datetime.date(2022, 1, 1),
            "period_end": datetime.date(2024, 1, 1),
            "max_iterations": 20,
            "current_iteration": 0,
            "best_sharpe": None,
            "best_win_rate": None,
            "best_iteration": None,
            "best_strategy_id": None,
            "stop_reason": None,
            "created_at": datetime.datetime(2026, 4, 10, 12, 0, 0, tzinfo=datetime.timezone.utc),
            "user_id": self.user_sub,
        }

        # Build a mock connection that acts as an async context manager
        mock_conn = AsyncMock()
        acquire_ctx = MagicMock()
        acquire_ctx.__aenter__ = AsyncMock(return_value=mock_conn)
        acquire_ctx.__aexit__ = AsyncMock(return_value=False)

        mock_pool = MagicMock()
        mock_pool.acquire.return_value = acquire_ctx

        mock_conn.fetchrow = AsyncMock(return_value=self.fake_run)
        mock_conn.fetch = AsyncMock(return_value=[self.fake_run])
        mock_conn.fetchval = AsyncMock(return_value=self.user_sub)

        # Override FastAPI dependencies
        app.dependency_overrides[get_current_user] = lambda: TokenData(sub=self.user_sub)
        app.dependency_overrides[get_pool] = lambda: mock_pool

        self.client = TestClient(app, raise_server_exceptions=False)
        self._mock_conn = mock_conn

        yield

        # Restore originals
        app.dependency_overrides.pop(get_current_user, None)
        app.dependency_overrides.pop(get_pool, None)

    def test_get_runs_returns_list(self):
        resp = self.client.get("/api/optimization/runs")
        assert resp.status_code == 200
        assert isinstance(resp.json(), list)

    def test_get_run_detail(self):
        resp = self.client.get(f"/api/optimization/runs/{self.run_id}")
        assert resp.status_code in (200, 404)

    def test_start_already_running_returns_409(self):
        from unittest.mock import AsyncMock
        running_row = {**self.fake_run, "status": "running"}
        self._mock_conn.fetchrow = AsyncMock(return_value=running_row)
        resp = self.client.post(f"/api/optimization/runs/{self.run_id}/start")
        assert resp.status_code == 409
