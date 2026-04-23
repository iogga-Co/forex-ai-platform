"""
Unit tests for live/oanda.py.

All HTTP calls are intercepted with httpx's MockTransport so no real network
calls are made.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone

import httpx
import pytest

from live.oanda import OandaClient, _from_oanda, _to_oanda


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_client(handler) -> OandaClient:
    """Create an OandaClient whose httpx calls go to a mock handler."""
    # We pass a fake base_url so the client doesn't hit OANDA
    client = OandaClient(
        api_key="test-key",
        account_id="001-001-TEST",
        environment="practice",
        base_url="https://api-mock.oanda.test",
        stream_url="https://stream-mock.oanda.test",
    )
    return client


# ---------------------------------------------------------------------------
# Format helpers
# ---------------------------------------------------------------------------

def test_to_oanda():
    assert _to_oanda("EURUSD") == "EUR_USD"
    assert _to_oanda("GBPJPY") == "GBP_JPY"
    assert _to_oanda("USDJPY") == "USD_JPY"


def test_from_oanda():
    assert _from_oanda("EUR_USD") == "EURUSD"
    assert _from_oanda("GBP_JPY") == "GBPJPY"


# ---------------------------------------------------------------------------
# stream_prices
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_stream_prices_yields_ticks(monkeypatch):
    """stream_prices should yield tick dicts for PRICE messages."""
    lines = [
        json.dumps({
            "type": "PRICE",
            "tradeable": True,
            "instrument": "EUR_USD",
            "bids": [{"price": "1.08000", "liquidity": 10000000}],
            "asks": [{"price": "1.08010", "liquidity": 10000000}],
            "time": "2026-04-21T10:00:00.000000Z",
        }),
        json.dumps({
            "type": "HEARTBEAT",
            "time": "2026-04-21T10:00:10.000000Z",
        }),
        json.dumps({
            "type": "PRICE",
            "tradeable": True,
            "instrument": "GBP_USD",
            "bids": [{"price": "1.26000", "liquidity": 10000000}],
            "asks": [{"price": "1.26015", "liquidity": 10000000}],
            "time": "2026-04-21T10:00:01.000000Z",
        }),
    ]

    # Mock the httpx streaming response
    class MockStreamResponse:
        status_code = 200

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            pass

        def raise_for_status(self):
            pass

        async def aiter_lines(self):
            for line in lines:
                yield line

    class MockAsyncClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            pass

        def stream(self, method, url, headers):
            return MockStreamResponse()

    monkeypatch.setattr("httpx.AsyncClient", lambda **kwargs: MockAsyncClient())

    client = OandaClient("key", "account", "practice",
                         base_url="https://mock", stream_url="https://mock-stream")
    results = []
    async for msg in client.stream_prices(["EURUSD", "GBPUSD"]):
        results.append(msg)
        if len(results) == 3:
            break

    ticks = [r for r in results if r["type"] == "tick"]
    heartbeats = [r for r in results if r["type"] == "heartbeat"]

    assert len(ticks) == 2
    assert len(heartbeats) == 1
    assert ticks[0]["pair"] == "EURUSD"
    assert ticks[0]["bid"] == pytest.approx(1.08000)
    assert ticks[0]["ask"] == pytest.approx(1.08010)
    assert ticks[1]["pair"] == "GBPUSD"


@pytest.mark.asyncio
async def test_stream_prices_skips_non_tradeable(monkeypatch):
    """stream_prices should skip PRICE messages with tradeable=False."""
    lines = [
        json.dumps({
            "type": "PRICE",
            "tradeable": False,
            "instrument": "EUR_USD",
            "bids": [{"price": "1.08000", "liquidity": 0}],
            "asks": [{"price": "1.08010", "liquidity": 0}],
            "time": "2026-04-21T10:00:00.000000Z",
        }),
    ]

    class MockStreamResponse:
        status_code = 200
        async def __aenter__(self): return self
        async def __aexit__(self, *args): pass
        def raise_for_status(self): pass
        async def aiter_lines(self):
            for line in lines:
                yield line

    class MockAsyncClient:
        async def __aenter__(self): return self
        async def __aexit__(self, *args): pass
        def stream(self, method, url, headers): return MockStreamResponse()

    monkeypatch.setattr("httpx.AsyncClient", lambda **kwargs: MockAsyncClient())

    client = OandaClient("key", "account", "practice",
                         base_url="https://mock", stream_url="https://mock-stream")
    results = []
    async for msg in client.stream_prices(["EURUSD"]):
        results.append(msg)

    assert results == []


# ---------------------------------------------------------------------------
# place_market_order
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_place_market_order(monkeypatch):
    """place_market_order should POST correct JSON and return the response."""
    expected_response = {
        "orderFillTransaction": {
            "id": "12345",
            "price": "1.08005",
            "units": "10000",
        }
    }

    class MockResponse:
        def raise_for_status(self): pass
        def json(self): return expected_response

    class MockAsyncClient:
        async def __aenter__(self): return self
        async def __aexit__(self, *args): pass
        async def post(self, url, json, **kwargs):
            assert "EUR_USD" in json["order"]["instrument"]
            assert json["order"]["units"] == "10000"
            return MockResponse()

    monkeypatch.setattr("httpx.AsyncClient", lambda **kwargs: MockAsyncClient())

    client = OandaClient("key", "account", "practice",
                         base_url="https://mock", stream_url="https://mock-stream")
    result = await client.place_market_order("EURUSD", 10000)
    assert result["orderFillTransaction"]["id"] == "12345"


@pytest.mark.asyncio
async def test_place_market_order_with_sl_tp(monkeypatch):
    """SL/TP prices should appear in the order JSON."""
    captured = {}

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

    client = OandaClient("key", "account", "practice",
                         base_url="https://mock", stream_url="https://mock-stream")
    await client.place_market_order("EURUSD", 10000, sl_price=1.07500, tp_price=1.09000)

    assert "stopLossOnFill" in captured["order"]
    assert "takeProfitOnFill" in captured["order"]
    assert captured["order"]["stopLossOnFill"]["price"] == "1.07500"


# ---------------------------------------------------------------------------
# close_position
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_close_position(monkeypatch):
    """close_position should PUT to the correct OANDA endpoint."""
    called_url = {}

    class MockResponse:
        def raise_for_status(self): pass
        def json(self): return {"relatedTransactionIDs": ["999"]}

    class MockAsyncClient:
        async def __aenter__(self): return self
        async def __aexit__(self, *args): pass
        async def put(self, url, json, **kwargs):
            called_url["url"] = url
            assert json == {"longUnits": "ALL", "shortUnits": "ALL"}
            return MockResponse()

    monkeypatch.setattr("httpx.AsyncClient", lambda **kwargs: MockAsyncClient())

    client = OandaClient("key", "account", "practice",
                         base_url="https://mock", stream_url="https://mock-stream")
    result = await client.close_position("EURUSD")
    assert "EUR_USD" in called_url["url"]
    assert "relatedTransactionIDs" in result
