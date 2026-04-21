"""
OANDA tick feed — runs as a long-lived asyncio task inside the FastAPI process.

Streams prices for all 6 pairs from OANDA and publishes each tick as JSON
to Redis channel  ticks:{PAIR}  (e.g. ticks:EURUSD).

Reconnects automatically on any error with exponential backoff (max 60 s).
Publishes a heartbeat message every ~10 s so the frontend can detect a stale feed.

Always runs regardless of LIVE_TRADING_ENABLED — the price ticker needs it.
"""

from __future__ import annotations

import asyncio
import json
import logging

import redis.asyncio as aioredis

from core.config import settings
from live.oanda import OandaClient

logger = logging.getLogger(__name__)

FEED_PAIRS   = ["EURUSD", "GBPUSD", "USDJPY", "EURGBP", "GBPJPY", "USDCHF"]
TICK_CHANNEL = "ticks:{pair}"


async def run_feed(stop_event: asyncio.Event) -> None:
    """
    Top-level feed coroutine registered in the FastAPI lifespan.
    Reconnects with exponential backoff on failure.
    """
    backoff = 1.0
    logger.info("OANDA feed starting (env=%s)", settings.oanda_environment)

    while not stop_event.is_set():
        try:
            await _stream_loop(stop_event)
            backoff = 1.0  # clean exit — reset backoff
        except asyncio.CancelledError:
            break
        except Exception as exc:
            logger.error("OANDA feed error: %s — reconnecting in %.0f s", exc, backoff)
            try:
                await asyncio.wait_for(
                    _wait_or_stop(stop_event, backoff), timeout=backoff + 1
                )
            except (asyncio.TimeoutError, asyncio.CancelledError):
                pass
            backoff = min(backoff * 2, 60.0)

    logger.info("OANDA feed stopped")


async def _wait_or_stop(stop_event: asyncio.Event, delay: float) -> None:
    """Sleep for delay seconds, but exit immediately if stop_event fires."""
    await asyncio.wait(
        [asyncio.create_task(stop_event.wait()), asyncio.create_task(asyncio.sleep(delay))],
        return_when=asyncio.FIRST_COMPLETED,
    )


async def _stream_loop(stop_event: asyncio.Event) -> None:
    """Connect to OANDA and publish ticks until stop_event or error."""
    client = OandaClient(
        api_key=settings.oanda_api_key,
        account_id=settings.oanda_account_id,
        environment=settings.oanda_environment,
    )
    r = aioredis.from_url(settings.redis_url, decode_responses=True)

    try:
        logger.info("OANDA feed connected — streaming %s", FEED_PAIRS)
        async for msg in client.stream_prices(FEED_PAIRS):
            if stop_event.is_set():
                break

            payload = json.dumps(msg)

            if msg["type"] == "tick":
                await r.publish(TICK_CHANNEL.format(pair=msg["pair"]), payload)

            elif msg["type"] == "heartbeat":
                # Broadcast the OANDA heartbeat to every pair channel so
                # all frontend subscribers can detect a live feed.
                for pair in FEED_PAIRS:
                    await r.publish(TICK_CHANNEL.format(pair=pair), payload)

    finally:
        await r.aclose()
