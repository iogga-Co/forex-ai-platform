"""
OANDA v20 REST + streaming client.

Thin async wrapper around the OANDA v20 API using httpx.
Constructor accepts base_url / stream_url so tests can point to a local mock.

All pair names use our internal format (EURUSD) and are converted to OANDA
format (EUR_USD) inside this module.
"""

from __future__ import annotations

import json
import logging
from collections.abc import AsyncGenerator
from typing import Any

import httpx

logger = logging.getLogger(__name__)

_REST_URLS = {
    "practice": "https://api-fxpractice.oanda.com",
    "live":     "https://api-fxtrade.oanda.com",
}
_STREAM_URLS = {
    "practice": "https://stream-fxpractice.oanda.com",
    "live":     "https://stream-fxtrade.oanda.com",
}


def _to_oanda(pair: str) -> str:
    """EURUSD → EUR_USD"""
    return f"{pair[:3]}_{pair[3:]}"


def _from_oanda(instrument: str) -> str:
    """EUR_USD → EURUSD"""
    return instrument.replace("_", "")


class OandaClient:
    def __init__(
        self,
        api_key: str,
        account_id: str,
        environment: str = "practice",
        *,
        base_url: str | None = None,
        stream_url: str | None = None,
    ) -> None:
        self._api_key    = api_key
        self._account_id = account_id
        self._base_url   = base_url   or _REST_URLS.get(environment,   _REST_URLS["practice"])
        self._stream_url = stream_url or _STREAM_URLS.get(environment, _STREAM_URLS["practice"])
        self._headers    = {
            "Authorization":  f"Bearer {api_key}",
            "Content-Type":   "application/json",
            "Accept-Datetime-Format": "RFC3339",
        }

    # ------------------------------------------------------------------
    # Streaming
    # ------------------------------------------------------------------

    async def stream_prices(
        self, pairs: list[str]
    ) -> AsyncGenerator[dict[str, Any], None]:
        """
        Yield parsed tick dicts from the OANDA price stream.

        Each dict is one of:
          {"type": "tick",      "pair": "EURUSD", "bid": 1.08001, "ask": 1.08012, "time": "..."}
          {"type": "heartbeat", "time": "..."}
        """
        instruments = ",".join(_to_oanda(p) for p in pairs)
        url = (
            f"{self._stream_url}/v3/accounts/{self._account_id}"
            f"/pricing/stream?instruments={instruments}"
        )
        async with httpx.AsyncClient(timeout=None) as client:
            async with client.stream("GET", url, headers=self._headers) as resp:
                resp.raise_for_status()
                async for raw in resp.aiter_lines():
                    if not raw.strip():
                        continue
                    try:
                        data = json.loads(raw)
                    except json.JSONDecodeError:
                        continue

                    msg_type = data.get("type")

                    if msg_type == "PRICE" and data.get("tradeable"):
                        bids = data.get("bids", [])
                        asks = data.get("asks", [])
                        if not bids or not asks:
                            continue
                        yield {
                            "type": "tick",
                            "pair": _from_oanda(data["instrument"]),
                            "bid":  float(bids[0]["price"]),
                            "ask":  float(asks[0]["price"]),
                            "time": data["time"],
                        }

                    elif msg_type == "HEARTBEAT":
                        yield {"type": "heartbeat", "time": data["time"]}

    # ------------------------------------------------------------------
    # Account
    # ------------------------------------------------------------------

    async def get_account_summary(self) -> dict[str, Any]:
        url = f"{self._base_url}/v3/accounts/{self._account_id}/summary"
        async with httpx.AsyncClient(headers=self._headers, timeout=10) as client:
            resp = await client.get(url)
            resp.raise_for_status()
            return resp.json()["account"]

    async def get_open_positions(self) -> list[dict[str, Any]]:
        url = f"{self._base_url}/v3/accounts/{self._account_id}/openPositions"
        async with httpx.AsyncClient(headers=self._headers, timeout=10) as client:
            resp = await client.get(url)
            resp.raise_for_status()
            return resp.json().get("positions", [])

    # ------------------------------------------------------------------
    # Orders
    # ------------------------------------------------------------------

    async def place_market_order(
        self,
        instrument: str,
        units: int,
        sl_price: float | None = None,
        tp_price: float | None = None,
    ) -> dict[str, Any]:
        """
        Place a market order.  units > 0 = long, units < 0 = short.
        Returns the OANDA order fill transaction dict.
        """
        order: dict[str, Any] = {
            "type":       "MARKET",
            "instrument": _to_oanda(instrument),
            "units":      str(units),
        }
        if sl_price is not None:
            order["stopLossOnFill"] = {"price": f"{sl_price:.5f}"}
        if tp_price is not None:
            order["takeProfitOnFill"] = {"price": f"{tp_price:.5f}"}

        url = f"{self._base_url}/v3/accounts/{self._account_id}/orders"
        async with httpx.AsyncClient(headers=self._headers, timeout=10) as client:
            resp = await client.post(url, json={"order": order})
            resp.raise_for_status()
            return resp.json()

    async def place_limit_order(
        self,
        instrument: str,
        units: int,
        price: float,
        expiry_seconds: int = 300,
        sl_price: float | None = None,
        tp_price: float | None = None,
    ) -> dict[str, Any]:
        """
        Place a GTD limit order.

        units > 0 = long, units < 0 = short.
        price: the limit entry price.
        expiry_seconds: OANDA cancels the order if unfilled by this deadline.
        Returns the OANDA order create transaction dict.
        """
        from datetime import datetime, timedelta, timezone
        expiry = (
            datetime.now(timezone.utc) + timedelta(seconds=expiry_seconds)
        ).strftime("%Y-%m-%dT%H:%M:%S.000000Z")

        order: dict[str, Any] = {
            "type":        "LIMIT",
            "instrument":  _to_oanda(instrument),
            "units":       str(units),
            "price":       f"{price:.5f}",
            "timeInForce": "GTD",
            "gtdTime":     expiry,
        }
        if sl_price is not None:
            order["stopLossOnFill"] = {"price": f"{sl_price:.5f}"}
        if tp_price is not None:
            order["takeProfitOnFill"] = {"price": f"{tp_price:.5f}"}

        url = f"{self._base_url}/v3/accounts/{self._account_id}/orders"
        async with httpx.AsyncClient(headers=self._headers, timeout=10) as client:
            resp = await client.post(url, json={"order": order})
            resp.raise_for_status()
            return resp.json()

    async def cancel_order(self, order_id: str) -> dict[str, Any]:
        """Cancel a pending order by its OANDA order ID."""
        url = (
            f"{self._base_url}/v3/accounts/{self._account_id}"
            f"/orders/{order_id}/cancel"
        )
        async with httpx.AsyncClient(headers=self._headers, timeout=10) as client:
            resp = await client.put(url)
            resp.raise_for_status()
            return resp.json()

    async def close_position(self, instrument: str) -> dict[str, Any]:
        """Close all units of an open position for the given instrument."""
        url = (
            f"{self._base_url}/v3/accounts/{self._account_id}"
            f"/positions/{_to_oanda(instrument)}/close"
        )
        async with httpx.AsyncClient(headers=self._headers, timeout=10) as client:
            resp = await client.put(url, json={"longUnits": "ALL", "shortUnits": "ALL"})
            resp.raise_for_status()
            return resp.json()
