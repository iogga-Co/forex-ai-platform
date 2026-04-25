"""
Trading Service — standalone process decoupled from the FastAPI web server.

Runs the OANDA tick feed, signal engine, and order executor in their own
asyncio event loop. A crash or restart of the web API cannot affect live
trading. Communication with the web layer is exclusively via Redis:

  ticks:{pair}                 feed → engine           (tick pub/sub)
  live:signals                 engine → executor       (signal pub/sub)
  live:commands                web → executor          (kill-switch commands)
  live:cmd_results:{req_id}    executor → web          (command responses)
  live:account_balance         executor → web          (balance cache, TTL 30s)
  live:heartbeat               health check key        (TTL 60s, written every 30s)
"""

from __future__ import annotations

import asyncio
import logging
import signal

import redis.asyncio as aioredis

from core import db as core_db
from core.config import settings
from live.engine import run_engine
from live.executor import LiveExecutor
from live.feed import run_feed

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(name)s %(levelname)s %(message)s",
)
logger = logging.getLogger(__name__)

HEARTBEAT_KEY      = "live:heartbeat"
HEARTBEAT_INTERVAL = 30   # seconds
HEARTBEAT_TTL      = 60   # Redis key TTL — 2× interval so a single missed write doesn't expire it


async def _write_heartbeat(stop: asyncio.Event) -> None:
    r = aioredis.from_url(settings.redis_url, decode_responses=True)
    try:
        while not stop.is_set():
            await r.setex(HEARTBEAT_KEY, HEARTBEAT_TTL, "ok")
            try:
                await asyncio.wait_for(stop.wait(), timeout=float(HEARTBEAT_INTERVAL))
            except asyncio.TimeoutError:
                pass
    except asyncio.CancelledError:
        pass
    finally:
        await r.aclose()


async def main() -> None:
    logger.info("Trading service starting (env=%s)", settings.oanda_environment)

    await core_db.init_pool(settings.database_url)
    pool = await core_db.get_pool()

    stop = asyncio.Event()

    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        try:
            loop.add_signal_handler(sig, stop.set)
        except NotImplementedError:
            pass  # Windows — signal handlers via loop not supported; Ctrl-C still works

    tasks: list[asyncio.Task] = [
        asyncio.create_task(run_feed(stop),             name="oanda-feed"),
        asyncio.create_task(run_engine(stop, pool),     name="signal-engine"),
        asyncio.create_task(_write_heartbeat(stop),     name="heartbeat"),
    ]

    if settings.live_trading_enabled:
        logger.info("LIVE_TRADING_ENABLED=true — starting order executor")
        executor = LiveExecutor(pool)
        tasks.append(asyncio.create_task(executor.run(stop), name="live-executor"))
    else:
        logger.info("LIVE_TRADING_ENABLED=false — shadow mode, executor not started")

    logger.info("Trading service running (%d tasks)", len(tasks))

    await stop.wait()

    logger.info("Trading service shutting down…")
    for t in tasks:
        t.cancel()
    await asyncio.gather(*tasks, return_exceptions=True)

    await core_db.close_pool()
    logger.info("Trading service stopped")


if __name__ == "__main__":
    asyncio.run(main())
