"""
Redis pub/sub bridge — connects synchronous Celery workers to async WebSocket clients.

The Problem
-----------
Celery workers run in a separate OS process from FastAPI.  They cannot directly
call `await manager.broadcast_to_session()` because that lives in the FastAPI
event loop.

The Solution
------------
Celery publishes JSON progress messages to a Redis pub/sub channel.
A background asyncio task running inside the FastAPI process subscribes to
that channel and calls `manager.broadcast_to_session()` to forward messages
to connected WebSocket clients.

Celery side (sync) — call publish_progress():
    redis_client = redis.Redis.from_url(settings.redis_url)
    publish_progress(redis_client, job_id="abc", session_id="xyz", pct=50)

FastAPI side (async) — started as asyncio.create_task() in main.py lifespan:
    task = asyncio.create_task(subscribe_and_forward(redis_url, ws_manager))
"""

import asyncio
import json
import logging

from core.websocket import ConnectionManager

logger = logging.getLogger(__name__)

PROGRESS_CHANNEL = "backtest:progress"


def publish_progress(
    redis_client,  # synchronous redis.Redis instance
    job_id: str,
    session_id: str,
    pct: int,
    msg: str = "",
    event_type: str = "progress",
    extra: dict | None = None,
) -> None:
    """Publish a progress event to Redis.  Called from Celery workers (sync)."""
    payload: dict = {
        "type": event_type,
        "job_id": job_id,
        "session_id": session_id,
        "value": pct,
        "msg": msg,
    }
    if extra:
        payload.update(extra)
    try:
        redis_client.publish(PROGRESS_CHANNEL, json.dumps(payload))
    except Exception:
        # Progress streaming is best-effort — never fail the backtest over it
        logger.warning("Redis publish failed for job %s (progress %d%%)", job_id, pct)


async def subscribe_and_forward(
    redis_url: str,
    ws_manager: ConnectionManager,
    stop_event: asyncio.Event | None = None,
) -> None:
    """
    Infinite loop: subscribe to Redis pub/sub and forward messages to WS clients.

    Launched as asyncio.create_task() in main.py lifespan.  Runs until the
    stop_event is set (at server shutdown) or the task is cancelled.
    """
    import redis.asyncio as aioredis

    while True:
        try:
            client = await aioredis.from_url(redis_url, decode_responses=True)
            pubsub = client.pubsub()
            await pubsub.subscribe(PROGRESS_CHANNEL)
            logger.info("Redis bridge: subscribed to %s", PROGRESS_CHANNEL)

            async for message in pubsub.listen():
                if stop_event and stop_event.is_set():
                    break
                if message["type"] != "message":
                    continue
                try:
                    data = json.loads(message["data"])
                    session_id = data.get("session_id", "")
                    if session_id:
                        await ws_manager.broadcast_to_session(session_id, data)
                except Exception as exc:
                    logger.warning("Redis bridge: failed to forward message: %s", exc)

            await pubsub.unsubscribe()
            await client.aclose()

        except asyncio.CancelledError:
            logger.info("Redis bridge: task cancelled — shutting down")
            return
        except Exception as exc:
            logger.error("Redis bridge: connection error: %s — reconnecting in 5s", exc)
            await asyncio.sleep(5)
