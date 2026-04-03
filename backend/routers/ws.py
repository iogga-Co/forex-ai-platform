from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from core.websocket import manager

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
