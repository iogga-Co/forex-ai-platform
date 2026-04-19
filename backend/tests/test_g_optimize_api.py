"""
Integration tests for /api/g-optimize/* endpoints.

Uses FastAPI TestClient with dependency overrides to bypass JWT auth and
inject a mock DB pool.  No real database, Redis, Celery, or AI calls.
"""

import datetime
import uuid
from decimal import Decimal
from unittest.mock import AsyncMock, MagicMock, patch

import pytest


# ---------------------------------------------------------------------------
# Shared fake data
# ---------------------------------------------------------------------------

RUN_ID        = str(uuid.uuid4())
BT_RUN_ID     = str(uuid.uuid4())
STRATEGY_ID   = str(uuid.uuid4())
USER_SUB      = "operator"

FAKE_RUN = {
    "id":                  RUN_ID,
    "user_id":             USER_SUB,
    "status":              "pending",
    "pairs":               ["EURUSD", "GBPUSD"],
    "timeframe":           "1H",
    "period_start":        datetime.date(2022, 1, 1),
    "period_end":          datetime.date(2024, 1, 1),
    "n_configs":           500,
    "store_trades":        "passing",
    "entry_config":        {"max_conditions": 2, "conditions": []},
    "exit_config":         {"exit_mode": "stops_only", "sl": {}, "tp": {}, "rr_floor": 1.5},
    "threshold_sharpe":    Decimal("0.80"),
    "threshold_win_rate":  Decimal("45.00"),
    "threshold_max_dd":    Decimal("15.00"),
    "threshold_min_trades": 30,
    "auto_rag":            True,
    "configs_total":       0,
    "configs_done":        0,
    "configs_passed":      0,
    "configs_failed":      0,
    "error_message":       None,
    "started_at":          None,
    "completed_at":        None,
    "created_at":          datetime.datetime(2026, 4, 19, 12, 0, 0, tzinfo=datetime.timezone.utc),
}

FAKE_STRATEGY_ROW = {
    "backtest_run_id": BT_RUN_ID,
    "pair":            "EURUSD",
    "timeframe":       "1H",
    "sharpe":          Decimal("1.42"),
    "win_rate":        Decimal("0.531"),
    "max_dd":          Decimal("-0.079"),
    "trade_count":     187,
    "ir":              {"entry_conditions": [], "exit_conditions": {"stop_loss": {"type": "atr", "period": 14, "multiplier": 1.5}, "take_profit": {"type": "atr", "period": 14, "multiplier": 3.0}}},
    "passed_threshold": True,
    "run_id":          RUN_ID,
    "rag_status":      "pending",
    "strategy_id":     None,
}


# ---------------------------------------------------------------------------
# TestClient fixture
# ---------------------------------------------------------------------------

@pytest.fixture
def g_opt_client():
    """TestClient with mocked auth + DB pool for g_optimize router."""
    from fastapi.testclient import TestClient
    from main import app
    from core.auth import get_current_user, TokenData
    from core.db import get_pool

    mock_conn = AsyncMock()
    acquire_ctx = MagicMock()
    acquire_ctx.__aenter__ = AsyncMock(return_value=mock_conn)
    acquire_ctx.__aexit__  = AsyncMock(return_value=False)

    mock_pool = MagicMock()
    mock_pool.acquire.return_value = acquire_ctx

    mock_conn.fetchrow = AsyncMock(return_value=FAKE_RUN)
    mock_conn.fetch    = AsyncMock(return_value=[FAKE_RUN])
    mock_conn.fetchval = AsyncMock(return_value=USER_SUB)
    mock_conn.execute  = AsyncMock(return_value=None)

    app.dependency_overrides[get_current_user] = lambda: TokenData(sub=USER_SUB)
    app.dependency_overrides[get_pool]         = lambda: mock_pool

    client = TestClient(app, raise_server_exceptions=False)
    yield client, mock_conn

    app.dependency_overrides.pop(get_current_user, None)
    app.dependency_overrides.pop(get_pool, None)


# ---------------------------------------------------------------------------
# POST /api/g-optimize/runs
# ---------------------------------------------------------------------------

class TestCreateRun:
    def test_creates_row_and_returns_id(self, g_opt_client):
        client, mock_conn = g_opt_client
        mock_conn.fetchrow = AsyncMock(return_value=FAKE_RUN)

        payload = {
            "pairs": ["EURUSD"],
            "period_start": "2022-01-01",
            "period_end": "2024-01-01",
            "n_configs": 500,
            "entry_config": {"max_conditions": 2, "conditions": []},
            "exit_config": {"exit_mode": "stops_only", "sl": {}, "tp": {}, "rr_floor": 1.5},
            "threshold_sharpe": 0.8,
            "threshold_win_rate": 45.0,
            "threshold_max_dd": 15.0,
            "threshold_min_trades": 30,
        }
        with patch("routers.g_optimize.run_g_optimize") as mock_task:
            mock_task.apply_async = MagicMock(return_value=MagicMock(id="celery-task-id"))
            resp = client.post("/api/g-optimize/runs", json=payload)

        assert resp.status_code == 201
        data = resp.json()
        assert "id" in data
        assert data["status"] == "pending"

    def test_n_configs_below_minimum_rejected(self, g_opt_client):
        client, _ = g_opt_client
        payload = {
            "pairs": ["EURUSD"],
            "period_start": "2022-01-01",
            "period_end": "2024-01-01",
            "n_configs": 50,   # below minimum of 100
            "entry_config": {},
            "exit_config": {},
            "threshold_sharpe": 0.8,
            "threshold_win_rate": 45.0,
            "threshold_max_dd": 15.0,
            "threshold_min_trades": 30,
        }
        with patch("routers.g_optimize.run_g_optimize"):
            resp = client.post("/api/g-optimize/runs", json=payload)
        assert resp.status_code == 422


# ---------------------------------------------------------------------------
# GET /api/g-optimize/runs
# ---------------------------------------------------------------------------

class TestListRuns:
    def test_returns_list(self, g_opt_client):
        client, mock_conn = g_opt_client
        mock_conn.fetch = AsyncMock(return_value=[FAKE_RUN])
        resp = client.get("/api/g-optimize/runs")
        assert resp.status_code == 200
        data = resp.json()
        assert isinstance(data, list)
        assert len(data) == 1
        assert data[0]["id"] == RUN_ID

    def test_returns_only_users_runs(self, g_opt_client):
        """Endpoint only fetches rows matching user_id — verified by SQL $1 binding."""
        client, mock_conn = g_opt_client
        mock_conn.fetch = AsyncMock(return_value=[])
        resp = client.get("/api/g-optimize/runs")
        assert resp.status_code == 200
        assert resp.json() == []
        # Verify user.sub was passed as first param to the DB query
        call_args = mock_conn.fetch.call_args
        assert USER_SUB in call_args.args


# ---------------------------------------------------------------------------
# GET /api/g-optimize/runs/{id}/strategies
# ---------------------------------------------------------------------------

class TestGetStrategies:
    def test_passed_tab_returns_passed_rows(self, g_opt_client):
        client, mock_conn = g_opt_client
        mock_conn.fetchval = AsyncMock(return_value=USER_SUB)   # ownership check → user
        mock_conn.fetch    = AsyncMock(return_value=[FAKE_STRATEGY_ROW])
        mock_conn.fetchval = AsyncMock(side_effect=[USER_SUB, 1])  # owner, count

        resp = client.get(f"/api/g-optimize/runs/{RUN_ID}/strategies?tab=passed")
        assert resp.status_code == 200
        data = resp.json()
        assert "items" in data
        assert "total" in data

    def test_unknown_run_returns_404(self, g_opt_client):
        client, mock_conn = g_opt_client
        mock_conn.fetchval = AsyncMock(return_value=None)  # ownership check → not found
        resp = client.get(f"/api/g-optimize/runs/{RUN_ID}/strategies?tab=passed")
        assert resp.status_code == 404


# ---------------------------------------------------------------------------
# POST /api/g-optimize/strategies/{id}/promote
# ---------------------------------------------------------------------------

class TestPromoteStrategy:
    def test_promote_updates_passed_threshold(self, g_opt_client):
        client, mock_conn = g_opt_client
        bt_row = {
            "id":          BT_RUN_ID,
            "sir_json":    {"entry_conditions": [], "exit_conditions": {"stop_loss": {"type": "atr", "period": 14, "multiplier": 1.5}, "take_profit": {"type": "atr", "period": 14, "multiplier": 3.0}}},
            "sharpe":      Decimal("1.2"),
            "win_rate":    Decimal("0.50"),
            "max_dd":      Decimal("-0.10"),
            "trade_count": 80,
            "pair":        "EURUSD",
            "timeframe":   "1H",
            "strategy_id": None,
        }
        mock_conn.fetchrow = AsyncMock(return_value=bt_row)
        mock_conn.fetchval = AsyncMock(return_value=STRATEGY_ID)
        mock_conn.execute  = AsyncMock(return_value=None)

        with patch("ai.voyage_client.embed", new_callable=AsyncMock) as mock_embed:
            mock_embed.return_value = [0.1] * 1024
            resp = client.post(f"/api/g-optimize/strategies/{BT_RUN_ID}/promote")

        assert resp.status_code == 200
        data = resp.json()
        assert data["rag_status"] == "in_rag"
        assert data["backtest_run_id"] == BT_RUN_ID

    def test_already_promoted_returns_in_rag_immediately(self, g_opt_client):
        client, mock_conn = g_opt_client
        bt_row_already = {
            "id": BT_RUN_ID, "sir_json": {}, "sharpe": None,
            "win_rate": None, "max_dd": None, "trade_count": 0,
            "pair": "EURUSD", "timeframe": "1H",
            "strategy_id": STRATEGY_ID,   # already linked
        }
        mock_conn.fetchrow = AsyncMock(return_value=bt_row_already)
        resp = client.post(f"/api/g-optimize/strategies/{BT_RUN_ID}/promote")
        assert resp.status_code == 200
        assert resp.json()["rag_status"] == "in_rag"


# ---------------------------------------------------------------------------
# POST /api/g-optimize/analyze
# ---------------------------------------------------------------------------

class TestAnalyze:
    def test_returns_ranked_recommendations(self, g_opt_client):
        client, mock_conn = g_opt_client

        analyze_row = dict(FAKE_STRATEGY_ROW)
        analyze_row["strategy_id"] = None
        mock_conn.fetch = AsyncMock(return_value=[analyze_row])

        mock_result = {
            "recommendations": [
                {
                    "rank": 1,
                    "backtest_run_id": BT_RUN_ID,
                    "summary": "RSI+EMA EURUSD Sharpe 1.42",
                    "rationale": "Strong edge across 187 trades.",
                    "suggested_refinement": "Tighten RSI threshold to 55.",
                }
            ],
            "skipped": [],
            "skipped_reason": "",
        }
        with patch("ai.g_optimize_agent.analyze_and_rank", new_callable=AsyncMock) as mock_rank:
            mock_rank.return_value = mock_result
            resp = client.post(
                "/api/g-optimize/analyze",
                json={
                    "backtest_run_ids": [BT_RUN_ID],
                    "scope": "checked",
                    "model": "claude-sonnet-4-6",
                },
            )

        assert resp.status_code == 200
        data = resp.json()
        assert len(data["recommendations"]) == 1
        assert data["recommendations"][0]["rank"] == 1
        assert "strategy_ids" in data

    def test_empty_scope_returns_empty_recommendations(self, g_opt_client):
        client, _ = g_opt_client
        resp = client.post(
            "/api/g-optimize/analyze",
            json={"backtest_run_ids": [], "scope": "checked", "model": "claude-sonnet-4-6"},
        )
        assert resp.status_code == 200
        assert resp.json()["recommendations"] == []
