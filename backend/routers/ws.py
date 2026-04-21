import json
import logging

import redis.asyncio as aioredis
from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from core.config import settings
from core.websocket import manager

logger = logging.getLogger(__name__)
router = APIRouter(tags=["WebSocket"])


@router.websocket("/ws/{session_id}")
async def websocket_endpoint(websocket: WebSocket, session_id: str) -> None:
    """
    WebSocket hub entry point.

    Clients connect here to receive real-time events:
      - Backtest progress updates  ({"type": "progress", "value": 0-100})
      - Backtest completion        ({"type": "complete", "result_id": "..."})
      - Live price ticks           ({"type": "tick", "pair": "EURUSD", "bid": ..., "ask": ...})
      - AI Co-Pilot streaming      ({"type": "copilot_chunk", "text": "..."})
      - Alert events               ({"type": "alert", "level": "critical", "message": "..."})

    session_id ties the WebSocket to a specific user session so that
    backtest progress is only sent to the tab that started the job.
    """
    await manager.connect(websocket, session_id)
    try:
        while True:
            # Keep connection alive — clients send periodic pings
            await websocket.receive_text()
    except WebSocketDisconnect:
        manager.disconnect(websocket, session_id)


@router.websocket("/ws/prices/{pair}")
async def price_feed(websocket: WebSocket, pair: str) -> None:
    """
    Real-time price feed for a single currency pair.

    Relays tick messages from the Redis  ticks:{pair}  channel published
    by live/feed.py.  Each message is one of:
      {"type": "tick",      "pair": "EURUSD", "bid": 1.08001, "ask": 1.08012, "time": "..."}
      {"type": "heartbeat", "time": "..."}
    No auth required — market data is not sensitive.
    """
    pair = pair.upper()
    await websocket.accept()
    r: aioredis.Redis | None = None
    try:
        r = aioredis.from_url(settings.redis_url, decode_responses=True)
        pubsub = r.pubsub()
        await pubsub.subscribe(f"ticks:{pair}")
        while True:
            msg = await pubsub.get_message(ignore_subscribe_messages=True, timeout=20.0)
            if msg is None:
                # Keep the WS alive while waiting for ticks
                await websocket.send_text(json.dumps({"type": "keepalive"}))
                continue
            await websocket.send_text(msg["data"])
    except WebSocketDisconnect:
        pass
    except Exception as exc:
        logger.warning("Price WS error for %s: %s", pair, exc)
    finally:
        if r is not None:
            try:
                await r.aclose()
            except Exception:
                pass
