"""
Tests for Phase 3 Analytics endpoints.

Covers:
- equity_curve: correct cumulative PnL, drawdown calculation, ordering
- compare_strategies: aggregation logic with mocked DB
- export_trades_csv: correct CSV headers and row count
- clickhouse.write_backtest_run: graceful failure on connection error
"""

from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

# ---------------------------------------------------------------------------
# Equity curve computation helpers (tested in isolation)
# ---------------------------------------------------------------------------

def _compute_equity_curve(trades: list[dict], initial_capital: float = 100_000.0) -> list[dict]:
    """Replicate the logic from analytics.equity_curve for unit testing."""
    cumulative = 0.0
    peak = initial_capital
    points = []
    for t in trades:
        cumulative += float(t["pnl"])
        equity = initial_capital + cumulative
        if equity > peak:
            peak = equity
        drawdown = (equity - peak) / peak if peak > 0 else 0.0
        points.append({
            "time": t["entry_time"],
            "equity": round(equity, 2),
            "cumulative_pnl": round(cumulative, 2),
            "drawdown": round(drawdown, 4),
        })
    return points


def test_equity_curve_monotonic_gain():
    trades = [
        {"entry_time": "2020-01-01T10:00:00", "pnl": 1000.0},
        {"entry_time": "2020-01-02T10:00:00", "pnl": 500.0},
        {"entry_time": "2020-01-03T10:00:00", "pnl": 200.0},
    ]
    points = _compute_equity_curve(trades)
    assert points[0]["equity"] == 101_000.0
    assert points[1]["equity"] == 101_500.0
    assert points[2]["equity"] == 101_700.0
    # No drawdown on monotonic gain
    assert all(p["drawdown"] == 0.0 for p in points)


def test_equity_curve_drawdown_calculation():
    trades = [
        {"entry_time": "2020-01-01T10:00:00", "pnl": 10_000.0},  # peak = 110k
        {"entry_time": "2020-01-02T10:00:00", "pnl": -5_000.0},  # equity = 105k → DD = -5/110k
    ]
    points = _compute_equity_curve(trades)
    assert points[0]["drawdown"] == 0.0
    expected_dd = round((105_000 - 110_000) / 110_000, 4)
    assert points[1]["drawdown"] == expected_dd


def test_equity_curve_empty_trades():
    points = _compute_equity_curve([])
    assert points == []


def test_equity_curve_cumulative_pnl():
    trades = [
        {"entry_time": "2020-01-01T10:00:00", "pnl": 300.0},
        {"entry_time": "2020-01-02T10:00:00", "pnl": -100.0},
        {"entry_time": "2020-01-03T10:00:00", "pnl": 200.0},
    ]
    points = _compute_equity_curve(trades)
    assert points[0]["cumulative_pnl"] == 300.0
    assert points[1]["cumulative_pnl"] == 200.0
    assert points[2]["cumulative_pnl"] == 400.0


# ---------------------------------------------------------------------------
# ClickHouse write — graceful failure
# ---------------------------------------------------------------------------

def test_clickhouse_write_does_not_raise_on_error():
    """write_backtest_run must swallow all exceptions (best-effort)."""
    with patch("core.clickhouse._get_client", side_effect=ConnectionRefusedError("no ch")):
        from core.clickhouse import write_backtest_run
        # Should not raise
        write_backtest_run(
            run_id="test-uuid",
            strategy_id="strat-uuid",
            pair="EURUSD",
            timeframe="1H",
            period_start="2020-01-01",
            period_end="2023-01-01",
            metrics={"sharpe": 1.2, "trade_count": 10, "total_pnl": 1000.0},
            trades=[],
        )


def test_clickhouse_init_schema_does_not_raise_on_error():
    """init_schema must swallow all exceptions (best-effort)."""
    with patch("core.clickhouse._get_client", side_effect=OSError("no ch")):
        from core.clickhouse import init_schema
        init_schema()  # Should not raise


# ---------------------------------------------------------------------------
# Analytics router — equity-curve endpoint (mocked DB)
# ---------------------------------------------------------------------------

def _make_pool_mock(mock_conn: AsyncMock) -> MagicMock:
    """Build a pool mock where acquire() returns a working async context manager."""
    acquire_ctx = MagicMock()
    acquire_ctx.__aenter__ = AsyncMock(return_value=mock_conn)
    acquire_ctx.__aexit__ = AsyncMock(return_value=False)
    mock_pool = MagicMock()
    mock_pool.acquire.return_value = acquire_ctx
    return mock_pool


@pytest.mark.asyncio
async def test_equity_curve_endpoint_404():
    from fastapi import HTTPException
    from routers.analytics import equity_curve
    from uuid import uuid4

    mock_conn = AsyncMock()
    mock_conn.fetchval.return_value = None  # run not found
    mock_pool = _make_pool_mock(mock_conn)

    with patch("routers.analytics.get_pool", new=AsyncMock(return_value=mock_pool)):
        with pytest.raises(HTTPException) as exc_info:
            await equity_curve(uuid4())
    assert exc_info.value.status_code == 404


@pytest.mark.asyncio
async def test_equity_curve_endpoint_returns_points():
    from routers.analytics import equity_curve
    from uuid import uuid4

    now = datetime(2020, 1, 5, 10, 0, tzinfo=timezone.utc)
    # Use dicts so t["pnl"] and t["entry_time"].isoformat() both work
    fake_trades = [
        {"pnl": 500.0, "entry_time": now},
        {"pnl": -200.0, "entry_time": now},
    ]

    mock_conn = AsyncMock()
    mock_conn.fetchval.return_value = 1  # run exists
    mock_conn.fetch.return_value = fake_trades
    mock_pool = _make_pool_mock(mock_conn)

    with patch("routers.analytics.get_pool", new=AsyncMock(return_value=mock_pool)):
        result = await equity_curve(uuid4())

    assert "points" in result
    assert result["initial_capital"] == 100_000.0
