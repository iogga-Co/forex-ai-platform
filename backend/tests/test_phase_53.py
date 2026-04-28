"""
Phase 5.3 — Advanced Execution tests.

Covers:
  - SpreadTracker: rolling spread calculation and gating
  - execute_twap: slice distribution and partial failure handling
  - LiveExecutor: spread gate, limit routing, TWAP routing
  - OandaClient: place_limit_order, cancel_order
  - ExecutionConfig: SIR schema parsing
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch
from uuid import uuid4

import pytest

# ---------------------------------------------------------------------------
# Helpers shared across test sections
# ---------------------------------------------------------------------------

def _make_pool_mock(conn: AsyncMock) -> MagicMock:
    ctx = MagicMock()
    ctx.__aenter__ = AsyncMock(return_value=conn)
    ctx.__aexit__  = AsyncMock(return_value=False)
    pool = MagicMock()
    pool.acquire.return_value = ctx
    return pool


def _make_executor(pool):
    from live.executor import LiveExecutor
    executor = LiveExecutor.__new__(LiveExecutor)
    executor._pool  = pool
    executor._oanda = AsyncMock()
    return executor


# ===========================================================================
# SpreadTracker
# ===========================================================================

class TestSpreadTracker:

    def test_returns_zero_with_no_data(self):
        from live.spread import SpreadTracker
        st = SpreadTracker()
        assert st.current_pips("EURUSD") == 0.0

    def test_acceptable_with_no_data(self):
        from live.spread import SpreadTracker
        st = SpreadTracker()
        assert st.is_acceptable("EURUSD", max_pips=1.0) is True

    def test_single_update(self):
        from live.spread import SpreadTracker
        st = SpreadTracker()
        # EURUSD pip = 0.0001; spread = 0.0001 = 1 pip
        st.update("EURUSD", bid=1.08000, ask=1.08010)
        assert st.current_pips("EURUSD") == pytest.approx(1.0, rel=0.01)

    def test_median_across_window(self):
        from live.spread import SpreadTracker
        st = SpreadTracker(window=5)
        # 5 ticks: spreads of 1, 2, 3, 4, 5 pips
        for pips in [1, 2, 3, 4, 5]:
            st.update("EURUSD", bid=1.08000, ask=1.08000 + pips * 0.0001)
        # median of [1,2,3,4,5] = 3
        assert st.current_pips("EURUSD") == pytest.approx(3.0, rel=0.01)

    def test_per_pair_isolation(self):
        from live.spread import SpreadTracker
        st = SpreadTracker()
        st.update("EURUSD", bid=1.08000, ask=1.08010)   # 1 pip (0.0001 / 0.0001)
        st.update("GBPUSD", bid=1.26000, ask=1.26030)   # 3 pips (0.0003 / 0.0001)
        assert st.current_pips("EURUSD") == pytest.approx(1.0, rel=0.01)
        assert st.current_pips("GBPUSD") == pytest.approx(3.0, rel=0.01)

    def test_jpy_pip_size(self):
        from live.spread import SpreadTracker
        st = SpreadTracker()
        # USDJPY pip = 0.01; spread of 0.01 = 1 pip
        st.update("USDJPY", bid=145.000, ask=145.010)
        assert st.current_pips("USDJPY") == pytest.approx(1.0, rel=0.01)

    def test_is_acceptable_within_limit(self):
        from live.spread import SpreadTracker
        st = SpreadTracker()
        st.update("EURUSD", bid=1.08000, ask=1.08001)  # 1 pip
        assert st.is_acceptable("EURUSD", max_pips=2.0) is True

    def test_is_acceptable_over_limit(self):
        from live.spread import SpreadTracker
        st = SpreadTracker()
        st.update("EURUSD", bid=1.08000, ask=1.08050)  # 5 pips (0.0005 / 0.0001)
        assert st.is_acceptable("EURUSD", max_pips=3.0) is False

    def test_rolling_window_drops_old_values(self):
        from live.spread import SpreadTracker
        st = SpreadTracker(window=3)
        # First 3 ticks: 10 pips each
        for _ in range(3):
            st.update("EURUSD", bid=1.08000, ask=1.08100)  # 10 pips
        # Next 3 ticks: 1 pip each — replaces old values
        for _ in range(3):
            st.update("EURUSD", bid=1.08000, ask=1.08010)  # 1 pip
        # Median should now be near 1 pip
        assert st.current_pips("EURUSD") == pytest.approx(1.0, rel=0.01)

    def test_ignores_zero_spread(self):
        from live.spread import SpreadTracker
        st = SpreadTracker()
        st.update("EURUSD", bid=1.08000, ask=1.08000)  # zero spread — bad tick
        assert st.current_pips("EURUSD") == 0.0  # nothing recorded


# ===========================================================================
# execute_twap
# ===========================================================================

class TestTwap:

    @pytest.mark.asyncio
    async def test_places_correct_number_of_slices(self):
        from live.twap import execute_twap
        oanda = AsyncMock()
        oanda.place_market_order = AsyncMock(return_value={
            "orderFillTransaction": {"id": "1", "price": "1.08000"}
        })
        with patch("live.twap.asyncio.sleep", new=AsyncMock()):
            results = await execute_twap(oanda, "EURUSD", 9000, slices=3, interval_sec=60)
        assert oanda.place_market_order.call_count == 3
        assert len(results) == 3

    @pytest.mark.asyncio
    async def test_total_units_preserved(self):
        """The sum of slice units must equal total_units exactly."""
        from live.twap import execute_twap
        placed_units: list[int] = []

        async def capture(instrument, units):
            placed_units.append(units)
            return {"orderFillTransaction": {"id": "x", "price": "1.08"}}

        oanda = AsyncMock()
        oanda.place_market_order.side_effect = capture

        with patch("live.twap.asyncio.sleep", new=AsyncMock()):
            await execute_twap(oanda, "EURUSD", 10_000, slices=3, interval_sec=60)

        assert sum(placed_units) == 10_000

    @pytest.mark.asyncio
    async def test_short_order_negative_units(self):
        from live.twap import execute_twap
        placed: list[int] = []

        async def capture(instrument, units):
            placed.append(units)
            return {}

        oanda = AsyncMock()
        oanda.place_market_order.side_effect = capture

        with patch("live.twap.asyncio.sleep", new=AsyncMock()):
            await execute_twap(oanda, "EURUSD", -6000, slices=2, interval_sec=30)

        assert all(u < 0 for u in placed)
        assert sum(placed) == -6000

    @pytest.mark.asyncio
    async def test_continues_on_slice_failure(self):
        """A failed slice must not abort the remaining slices."""
        from live.twap import execute_twap
        call_count = 0

        async def flaky(instrument, units):
            nonlocal call_count
            call_count += 1
            if call_count == 2:
                raise Exception("Network error on slice 2")
            return {"orderFillTransaction": {"id": str(call_count), "price": "1.08"}}

        oanda = AsyncMock()
        oanda.place_market_order.side_effect = flaky

        with patch("live.twap.asyncio.sleep", new=AsyncMock()):
            results = await execute_twap(oanda, "EURUSD", 9000, slices=3, interval_sec=60)

        assert len(results) == 3
        assert "error" in results[1]
        assert "orderFillTransaction" in results[0]
        assert "orderFillTransaction" in results[2]

    @pytest.mark.asyncio
    async def test_raises_on_fewer_than_two_slices(self):
        from live.twap import execute_twap
        with pytest.raises(ValueError, match="at least 2"):
            await execute_twap(AsyncMock(), "EURUSD", 1000, slices=1, interval_sec=60)

    @pytest.mark.asyncio
    async def test_raises_on_zero_units(self):
        from live.twap import execute_twap
        with pytest.raises(ValueError, match="non-zero"):
            await execute_twap(AsyncMock(), "EURUSD", 0, slices=3, interval_sec=60)


# ===========================================================================
# LiveExecutor — spread gating
# ===========================================================================

class TestExecutorSpreadGate:

    @pytest.mark.asyncio
    async def test_skips_signal_when_spread_too_wide(self):
        conn = AsyncMock()
        pool = _make_pool_mock(conn)
        executor = _make_executor(pool)

        ir = {
            "execution": {"max_spread_pips": 2.0, "mode": "market"},
            "exit_conditions": {"stop_loss": {"type": "atr", "period": 14, "multiplier": 1.5}},
            "position_sizing": {"risk_per_trade_pct": 1.0},
        }
        executor._fetch_strategy_ir = AsyncMock(return_value=ir)

        signal = {
            "pair": "EURUSD",
            "strategy_id": str(uuid4()),
            "direction": "long",
            "atr_value": 0.001,
            "spread_pips": 5.0,  # exceeds max_spread_pips=2.0
        }
        await executor._handle_signal(signal)

        # No order should be inserted or placed
        conn.fetchrow.assert_not_called()
        executor._oanda.place_market_order.assert_not_called()

    @pytest.mark.asyncio
    async def test_proceeds_when_spread_acceptable(self):
        order_id = uuid4()
        conn = AsyncMock()
        conn.fetchrow = AsyncMock(return_value={"id": order_id})
        pool = _make_pool_mock(conn)
        executor = _make_executor(pool)

        ir = {
            "execution": {"max_spread_pips": 3.0, "mode": "market"},
            "exit_conditions": {"stop_loss": {"type": "atr", "period": 14, "multiplier": 1.5}},
            "position_sizing": {"risk_per_trade_pct": 1.0},
        }
        executor._fetch_strategy_ir = AsyncMock(return_value=ir)
        executor._oanda.get_account_summary = AsyncMock(return_value={"balance": "10000"})
        executor._oanda.place_market_order = AsyncMock(return_value={
            "orderFillTransaction": {"id": "oanda-1", "price": "1.08"}
        })

        signal = {
            "pair": "EURUSD",
            "strategy_id": str(uuid4()),
            "direction": "long",
            "atr_value": 0.001,
            "spread_pips": 1.5,  # within max_spread_pips=3.0
        }
        await executor._handle_signal(signal)

        executor._oanda.place_market_order.assert_called_once()

    @pytest.mark.asyncio
    async def test_proceeds_when_no_spread_in_signal(self):
        """Signals without spread_pips (e.g. from old engine) must not be blocked."""
        order_id = uuid4()
        conn = AsyncMock()
        conn.fetchrow = AsyncMock(return_value={"id": order_id})
        pool = _make_pool_mock(conn)
        executor = _make_executor(pool)

        ir = {
            "execution": {"max_spread_pips": 2.0, "mode": "market"},
            "exit_conditions": {"stop_loss": {"type": "atr", "period": 14, "multiplier": 1.5}},
            "position_sizing": {"risk_per_trade_pct": 1.0},
        }
        executor._fetch_strategy_ir = AsyncMock(return_value=ir)
        executor._oanda.get_account_summary = AsyncMock(return_value={"balance": "10000"})
        executor._oanda.place_market_order = AsyncMock(return_value={
            "orderFillTransaction": {"id": "oanda-1", "price": "1.08"}
        })

        signal = {
            "pair": "EURUSD",
            "strategy_id": str(uuid4()),
            "direction": "long",
            "atr_value": 0.001,
            # spread_pips absent
        }
        await executor._handle_signal(signal)

        executor._oanda.place_market_order.assert_called_once()


# ===========================================================================
# LiveExecutor — limit order routing
# ===========================================================================

class TestExecutorLimitOrder:

    @pytest.mark.asyncio
    async def test_limit_order_placed_below_close_for_long(self):
        order_id = uuid4()
        conn = AsyncMock()
        conn.fetchrow = AsyncMock(return_value={"id": order_id})
        pool = _make_pool_mock(conn)
        executor = _make_executor(pool)

        ir = {
            "execution": {
                "mode": "limit",
                "limit_offset_atr": 0.5,
                "limit_expiry_minutes": 5,
                "max_spread_pips": 10.0,
            },
            "exit_conditions": {"stop_loss": {"type": "atr", "period": 14, "multiplier": 1.5}},
            "position_sizing": {"risk_per_trade_pct": 1.0},
        }
        executor._fetch_strategy_ir = AsyncMock(return_value=ir)
        executor._oanda.get_account_summary = AsyncMock(return_value={"balance": "10000"})
        executor._oanda.place_limit_order = AsyncMock(return_value={
            "orderCreateTransaction": {"id": "limit-1"}
        })

        signal = {
            "pair": "EURUSD",
            "strategy_id": str(uuid4()),
            "direction": "long",
            "atr_value": 0.001,
            "close_price": 1.08000,
            "spread_pips": 0.8,
        }

        # Patch the monitor task so it doesn't fire during the test
        with patch.object(executor, "_monitor_limit_expiry", new=AsyncMock()):
            await executor._handle_signal(signal)

        executor._oanda.place_limit_order.assert_called_once()
        call_kwargs = executor._oanda.place_limit_order.call_args
        placed_price = call_kwargs.kwargs.get("price") or call_kwargs.args[2]
        # limit_price = 1.08000 - 0.5 × 0.001 = 1.07950
        assert placed_price == pytest.approx(1.07950, abs=1e-5)

    @pytest.mark.asyncio
    async def test_limit_order_placed_above_close_for_short(self):
        order_id = uuid4()
        conn = AsyncMock()
        conn.fetchrow = AsyncMock(return_value={"id": order_id})
        pool = _make_pool_mock(conn)
        executor = _make_executor(pool)

        ir = {
            "execution": {
                "mode": "limit",
                "limit_offset_atr": 1.0,
                "limit_expiry_minutes": 5,
                "max_spread_pips": 10.0,
            },
            "exit_conditions": {"stop_loss": {"type": "atr", "period": 14, "multiplier": 1.5}},
            "position_sizing": {"risk_per_trade_pct": 1.0},
        }
        executor._fetch_strategy_ir = AsyncMock(return_value=ir)
        executor._oanda.get_account_summary = AsyncMock(return_value={"balance": "10000"})
        executor._oanda.place_limit_order = AsyncMock(return_value={
            "orderCreateTransaction": {"id": "limit-2"}
        })

        signal = {
            "pair": "EURUSD",
            "strategy_id": str(uuid4()),
            "direction": "short",
            "atr_value": 0.002,
            "close_price": 1.08000,
            "spread_pips": 0.8,
        }

        with patch.object(executor, "_monitor_limit_expiry", new=AsyncMock()):
            await executor._handle_signal(signal)

        executor._oanda.place_limit_order.assert_called_once()
        call_kwargs = executor._oanda.place_limit_order.call_args
        placed_price = call_kwargs.kwargs.get("price") or call_kwargs.args[2]
        # limit_price = 1.08000 + 1.0 × 0.002 = 1.08200
        assert placed_price == pytest.approx(1.08200, abs=1e-5)

    @pytest.mark.asyncio
    async def test_limit_order_rejected_when_no_close_price(self):
        order_id = uuid4()
        conn = AsyncMock()
        conn.fetchrow = AsyncMock(return_value={"id": order_id})
        pool = _make_pool_mock(conn)
        executor = _make_executor(pool)

        ir = {
            "execution": {"mode": "limit", "limit_offset_atr": 0.5, "max_spread_pips": 10.0},
            "exit_conditions": {"stop_loss": {"type": "atr", "period": 14, "multiplier": 1.5}},
            "position_sizing": {"risk_per_trade_pct": 1.0},
        }
        executor._fetch_strategy_ir = AsyncMock(return_value=ir)
        executor._oanda.get_account_summary = AsyncMock(return_value={"balance": "10000"})

        signal = {
            "pair": "EURUSD",
            "strategy_id": str(uuid4()),
            "direction": "long",
            "atr_value": 0.001,
            # close_price absent
        }

        await executor._handle_signal(signal)

        executor._oanda.place_limit_order.assert_not_called()
        # Should have called _update_order_rejected via conn.execute
        conn.execute.assert_called()


# ===========================================================================
# LiveExecutor — TWAP routing
# ===========================================================================

class TestExecutorTwap:

    @pytest.mark.asyncio
    async def test_twap_executed_via_mode(self):
        order_id = uuid4()
        conn = AsyncMock()
        conn.fetchrow = AsyncMock(return_value={"id": order_id})
        pool = _make_pool_mock(conn)
        executor = _make_executor(pool)

        ir = {
            "execution": {
                "mode": "twap",
                "twap_slices": 2,
                "twap_interval_minutes": 1,
                "max_spread_pips": 10.0,
            },
            "exit_conditions": {"stop_loss": {"type": "atr", "period": 14, "multiplier": 1.5}},
            "position_sizing": {"risk_per_trade_pct": 1.0},
        }
        executor._fetch_strategy_ir = AsyncMock(return_value=ir)
        executor._oanda.get_account_summary = AsyncMock(return_value={"balance": "10000"})
        executor._oanda.place_market_order = AsyncMock(return_value={
            "orderFillTransaction": {"id": "twap-1", "price": "1.08"}
        })

        signal = {
            "pair": "EURUSD",
            "strategy_id": str(uuid4()),
            "direction": "long",
            "atr_value": 0.001,
            "spread_pips": 0.8,
        }

        with patch("live.executor.execute_twap") as mock_twap:
            mock_twap.return_value = [
                {"orderFillTransaction": {"id": "t1", "price": "1.08"}},
                {"orderFillTransaction": {"id": "t2", "price": "1.08"}},
            ]
            # Make it an awaitable
            async def _twap(*args, **kwargs):
                return mock_twap.return_value
            mock_twap.side_effect = _twap

            await executor._handle_signal(signal)

        mock_twap.assert_called_once()
        # Verify filled status was written
        conn.execute.assert_called()


# ===========================================================================
# OandaClient — place_limit_order
# ===========================================================================

class TestOandaLimitOrder:

    @pytest.mark.asyncio
    async def test_limit_order_posts_correct_type(self, monkeypatch):
        captured: dict = {}

        class MockResponse:
            def raise_for_status(self): pass
            def json(self): return {"orderCreateTransaction": {"id": "lim-1"}}

        class MockAsyncClient:
            async def __aenter__(self): return self
            async def __aexit__(self, *args): pass
            async def post(self, url, json, **kwargs):
                captured["order"] = json["order"]
                return MockResponse()

        monkeypatch.setattr("httpx.AsyncClient", lambda **kwargs: MockAsyncClient())

        from live.oanda import OandaClient
        client = OandaClient("key", "account", "practice",
                             base_url="https://mock", stream_url="https://mock")
        result = await client.place_limit_order("EURUSD", 10000, price=1.07950)

        assert captured["order"]["type"] == "LIMIT"
        assert captured["order"]["instrument"] == "EUR_USD"
        assert captured["order"]["units"] == "10000"
        assert captured["order"]["price"] == "1.07950"
        assert captured["order"]["timeInForce"] == "GTD"
        assert "gtdTime" in captured["order"]
        assert result["orderCreateTransaction"]["id"] == "lim-1"

    @pytest.mark.asyncio
    async def test_limit_order_includes_sl_tp(self, monkeypatch):
        captured: dict = {}

        class MockResponse:
            def raise_for_status(self): pass
            def json(self): return {}

        class MockAsyncClient:
            async def __aenter__(self): return self
            async def __aexit__(self, *args): pass
            async def post(self, url, json, **kwargs):
                captured["order"] = json["order"]
                return MockResponse()

        monkeypatch.setattr("httpx.AsyncClient", lambda **kwargs: MockAsyncClient())

        from live.oanda import OandaClient
        client = OandaClient("key", "account", "practice",
                             base_url="https://mock", stream_url="https://mock")
        await client.place_limit_order(
            "EURUSD", 10000, price=1.07950,
            sl_price=1.07500, tp_price=1.09000,
        )

        assert "stopLossOnFill" in captured["order"]
        assert "takeProfitOnFill" in captured["order"]
        assert captured["order"]["stopLossOnFill"]["price"] == "1.07500"


# ===========================================================================
# OandaClient — cancel_order
# ===========================================================================

class TestOandaCancelOrder:

    @pytest.mark.asyncio
    async def test_cancel_order_puts_correct_url(self, monkeypatch):
        called: dict = {}

        class MockResponse:
            def raise_for_status(self): pass
            def json(self): return {"orderCancelTransaction": {"id": "c1"}}

        class MockAsyncClient:
            async def __aenter__(self): return self
            async def __aexit__(self, *args): pass
            async def put(self, url, **kwargs):
                called["url"] = url
                return MockResponse()

        monkeypatch.setattr("httpx.AsyncClient", lambda **kwargs: MockAsyncClient())

        from live.oanda import OandaClient
        client = OandaClient("key", "account", "practice",
                             base_url="https://mock", stream_url="https://mock")
        result = await client.cancel_order("12345")

        assert "12345" in called["url"]
        assert "cancel" in called["url"]
        assert "orderCancelTransaction" in result


# ===========================================================================
# ExecutionConfig — SIR schema
# ===========================================================================

class TestExecutionConfig:

    def test_default_values(self):
        from engine.sir import ExecutionConfig
        cfg = ExecutionConfig()
        assert cfg.mode == "market"
        assert cfg.limit_offset_atr == 0.5
        assert cfg.limit_expiry_minutes == 5
        assert cfg.twap_slices == 3
        assert cfg.twap_interval_minutes == 2
        assert cfg.max_spread_pips == 3.0

    def test_limit_mode_parsing(self):
        from engine.sir import ExecutionConfig
        cfg = ExecutionConfig(mode="limit", limit_offset_atr=1.0, limit_expiry_minutes=10)
        assert cfg.mode == "limit"
        assert cfg.limit_offset_atr == 1.0
        assert cfg.limit_expiry_minutes == 10

    def test_twap_mode_parsing(self):
        from engine.sir import ExecutionConfig
        cfg = ExecutionConfig(mode="twap", twap_slices=5, twap_interval_minutes=3)
        assert cfg.mode == "twap"
        assert cfg.twap_slices == 5
        assert cfg.twap_interval_minutes == 3

    def test_strategy_ir_includes_execution(self):
        from engine.sir import StrategyIR
        raw = {
            "entry_conditions": [
                {"indicator": "RSI", "period": 14, "operator": ">", "value": 50}
            ],
            "exit_conditions": {
                "stop_loss":   {"type": "atr", "period": 14, "multiplier": 1.5},
                "take_profit": {"type": "atr", "period": 14, "multiplier": 3.0},
            },
            "execution": {
                "mode": "twap",
                "twap_slices": 4,
                "max_spread_pips": 2.5,
            },
        }
        ir = StrategyIR(**raw)
        assert ir.execution.mode == "twap"
        assert ir.execution.twap_slices == 4
        assert ir.execution.max_spread_pips == 2.5

    def test_strategy_ir_execution_defaults_to_market(self):
        from engine.sir import StrategyIR
        raw = {
            "entry_conditions": [
                {"indicator": "EMA", "period": 20, "operator": "price_above"}
            ],
            "exit_conditions": {
                "stop_loss":   {"type": "atr", "period": 14, "multiplier": 1.5},
                "take_profit": {"type": "atr", "period": 14, "multiplier": 3.0},
            },
        }
        ir = StrategyIR(**raw)
        assert ir.execution.mode == "market"
        assert ir.execution.max_spread_pips == 3.0

    def test_invalid_mode_rejected(self):
        from engine.sir import ExecutionConfig
        with pytest.raises(Exception):
            ExecutionConfig(mode="instant")  # not in Literal

    def test_twap_slices_minimum(self):
        from engine.sir import ExecutionConfig
        with pytest.raises(Exception):
            ExecutionConfig(mode="twap", twap_slices=1)  # ge=2
