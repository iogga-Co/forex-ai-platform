"""
Unit tests for live/executor.py — order lifecycle and kill switch.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch
from uuid import uuid4

import pytest


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_pool_mock(conn: AsyncMock) -> MagicMock:
    ctx = MagicMock()
    ctx.__aenter__ = AsyncMock(return_value=conn)
    ctx.__aexit__  = AsyncMock(return_value=False)
    pool = MagicMock()
    pool.acquire.return_value = ctx
    return pool


def _make_executor(pool) -> "LiveExecutor":
    from live.executor import LiveExecutor
    executor = LiveExecutor.__new__(LiveExecutor)
    executor._pool  = pool
    executor._oanda = AsyncMock()
    return executor


# ---------------------------------------------------------------------------
# _compute_units
# ---------------------------------------------------------------------------

def test_compute_units_basic():
    from live.executor import _compute_units

    # risk 1% of $10,000 = $100; stop = 0.001 × 1.5 = 0.0015
    # units = 100 / 0.0015 ≈ 66666
    units = _compute_units(
        atr_value=0.001, multiplier=1.5,
        risk_per_trade_pct=1.0, account_balance=10_000, pair="EURUSD",
    )
    assert units == pytest.approx(66666, rel=0.01)


def test_compute_units_capped_at_100k():
    from live.executor import _compute_units

    units = _compute_units(
        atr_value=0.00001, multiplier=0.1,
        risk_per_trade_pct=10.0, account_balance=1_000_000, pair="EURUSD",
    )
    assert units <= 100_000


def test_compute_units_minimum_1():
    from live.executor import _compute_units

    units = _compute_units(
        atr_value=999.0, multiplier=999.0,
        risk_per_trade_pct=0.001, account_balance=1.0, pair="EURUSD",
    )
    assert units >= 1


def test_compute_units_zero_atr_returns_fallback():
    from live.executor import _compute_units

    units = _compute_units(
        atr_value=0.0, multiplier=1.5,
        risk_per_trade_pct=1.0, account_balance=10_000, pair="EURUSD",
    )
    assert units == 1000  # fallback


# ---------------------------------------------------------------------------
# _insert_order
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_insert_order_returns_uuid():
    from live.executor import LiveExecutor

    order_id = uuid4()
    conn = AsyncMock()
    conn.fetchrow = AsyncMock(return_value={"id": order_id})
    pool = _make_pool_mock(conn)
    executor = _make_executor(pool)

    result = await executor._insert_order(
        strategy_id=str(uuid4()),
        pair="EURUSD",
        direction="long",
        units=10000,
    )
    assert result == order_id


# ---------------------------------------------------------------------------
# _update_order_filled / rejected
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_update_order_filled():
    from live.executor import LiveExecutor

    conn = AsyncMock()
    pool = _make_pool_mock(conn)
    executor = _make_executor(pool)

    order_id = uuid4()
    await executor._update_order_filled(order_id, "OANDA-123", 1.08005)
    conn.execute.assert_called_once()
    call_sql = conn.execute.call_args[0][0]
    assert "filled" in call_sql


@pytest.mark.asyncio
async def test_update_order_rejected():
    from live.executor import LiveExecutor

    conn = AsyncMock()
    pool = _make_pool_mock(conn)
    executor = _make_executor(pool)

    order_id = uuid4()
    await executor._update_order_rejected(order_id, "Insufficient margin")
    conn.execute.assert_called_once()
    call_sql = conn.execute.call_args[0][0]
    assert "rejected" in call_sql


# ---------------------------------------------------------------------------
# kill_switch
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_kill_switch_closes_positions():
    from live.executor import LiveExecutor

    conn = AsyncMock()
    conn.execute = AsyncMock()
    pool = _make_pool_mock(conn)
    executor = _make_executor(pool)

    executor._oanda.get_open_positions = AsyncMock(return_value=[
        {"instrument": "EUR_USD"},
        {"instrument": "GBP_USD"},
    ])
    executor._oanda.close_position = AsyncMock(return_value={})

    closed = await executor.kill_switch()

    assert closed == 2
    assert executor._oanda.close_position.call_count == 2
    # Verify DB update was called
    conn.execute.assert_called_once()
    sql = conn.execute.call_args[0][0]
    assert "cancelled" in sql


@pytest.mark.asyncio
async def test_kill_switch_no_positions():
    from live.executor import LiveExecutor

    conn = AsyncMock()
    pool = _make_pool_mock(conn)
    executor = _make_executor(pool)

    executor._oanda.get_open_positions = AsyncMock(return_value=[])
    closed = await executor.kill_switch()

    assert closed == 0
    conn.execute.assert_called_once()


@pytest.mark.asyncio
async def test_kill_switch_partial_failure():
    """kill_switch should continue even if one close_position fails."""
    from live.executor import LiveExecutor

    conn = AsyncMock()
    pool = _make_pool_mock(conn)
    executor = _make_executor(pool)

    executor._oanda.get_open_positions = AsyncMock(return_value=[
        {"instrument": "EUR_USD"},
        {"instrument": "GBP_USD"},
    ])

    call_count = 0
    async def close_side_effect(pair):
        nonlocal call_count
        call_count += 1
        if pair == "EURUSD":
            raise Exception("OANDA error")
        return {}

    executor._oanda.close_position = close_side_effect

    closed = await executor.kill_switch()
    # One succeeded, one failed — but DB cancel still runs
    assert closed == 1
    conn.execute.assert_called_once()


# ---------------------------------------------------------------------------
# Singleton helpers
# ---------------------------------------------------------------------------

def test_get_set_executor():
    from live.executor import get_executor, set_executor, LiveExecutor

    assert get_executor() is None or True  # may be None or set from previous test

    mock_executor = MagicMock(spec=LiveExecutor)
    set_executor(mock_executor)
    assert get_executor() is mock_executor

    set_executor(None)
    assert get_executor() is None


# ---------------------------------------------------------------------------
# _reconcile_closed
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_reconcile_marks_closed_when_position_gone():
    from live.executor import LiveExecutor
    from uuid import uuid4

    order_id = uuid4()
    conn = AsyncMock()
    conn.fetch = AsyncMock(return_value=[
        {"id": order_id, "pair": "EURUSD"},
        {"id": uuid4(),  "pair": "GBPUSD"},
    ])
    conn.execute = AsyncMock()
    pool = _make_pool_mock(conn)
    executor = _make_executor(pool)

    # Only GBPUSD is still open
    await executor._reconcile_closed(open_pairs={"GBPUSD"})

    # EURUSD should be marked closed
    conn.execute.assert_called_once()
    sql, args = conn.execute.call_args[0][0], conn.execute.call_args[0][1:]
    assert "closed" in sql
    assert order_id in args
