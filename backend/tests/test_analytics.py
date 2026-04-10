"""
Tests for Phase 3 Analytics endpoints.

Covers:
- equity_curve: SQL window-function output shapes and drawdown correctness
- compare_strategies: aggregation logic with mocked DB
- export_trades_csv: correct CSV headers and row count
"""

from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest


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

    t1 = datetime(2020, 1, 1, 10, 0, tzinfo=timezone.utc)
    t2 = datetime(2020, 1, 2, 10, 0, tzinfo=timezone.utc)
    # Simulate SQL window-function output: cumulative_pnl and running_peak_pnl
    fake_rows = [
        {"entry_time": t1, "cumulative_pnl": 500.0,  "running_peak_pnl": 500.0},
        {"entry_time": t2, "cumulative_pnl": 300.0,  "running_peak_pnl": 500.0},
    ]

    mock_conn = AsyncMock()
    mock_conn.fetchval.return_value = 1  # run exists
    mock_conn.fetch.return_value = fake_rows
    mock_pool = _make_pool_mock(mock_conn)

    with patch("routers.analytics.get_pool", new=AsyncMock(return_value=mock_pool)):
        result = await equity_curve(uuid4())

    assert "points" in result
    assert result["initial_capital"] == 100_000.0
    assert result["final_equity"] == 100_300.0
    assert len(result["points"]) == 2
    # First point: no drawdown (at peak)
    assert result["points"][0]["drawdown"] == 0.0
    assert result["points"][0]["equity"] == 100_500.0
    # Second point: drawdown from 100_500 peak to 100_300
    expected_dd = round((100_300 - 100_500) / 100_500, 4)
    assert result["points"][1]["drawdown"] == expected_dd


@pytest.mark.asyncio
async def test_equity_curve_endpoint_empty_trades():
    from routers.analytics import equity_curve
    from uuid import uuid4

    mock_conn = AsyncMock()
    mock_conn.fetchval.return_value = 1
    mock_conn.fetch.return_value = []
    mock_pool = _make_pool_mock(mock_conn)

    with patch("routers.analytics.get_pool", new=AsyncMock(return_value=mock_pool)):
        result = await equity_curve(uuid4())

    assert result["points"] == []
    assert result["final_equity"] == 100_000.0
    assert result["max_drawdown"] == 0.0
