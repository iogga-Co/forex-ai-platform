import json
from typing import Any

from fastapi import WebSocket


class ConnectionManager:
    """
    WebSocket hub — manages all active connections and broadcasts messages.

    Usage:
        manager = ConnectionManager()

        # In a WebSocket endpoint:
        await manager.connect(websocket, session_id)
        try:
            while True:
                data = await websocket.receive_text()
                ...
        finally:
            manager.disconnect(websocket, session_id)

        # From anywhere (e.g. Celery task completion callback):
        await manager.broadcast_to_session(session_id, {"type": "progress", "value": 80})
    """

    def __init__(self) -> None:
        # session_id → list of active WebSocket connections for that session
        self._connections: dict[str, list[WebSocket]] = {}

    async def connect(self, websocket: WebSocket, session_id: str) -> None:
        await websocket.accept()
        if session_id not in self._connections:
            self._connections[session_id] = []
        self._connections[session_id].append(websocket)

    def disconnect(self, websocket: WebSocket, session_id: str) -> None:
        if session_id in self._connections:
            self._connections[session_id].discard(websocket) if hasattr(
                self._connections[session_id], "discard"
            ) else self._connections[session_id].remove(websocket)
            if not self._connections[session_id]:
                del self._connections[session_id]

    async def broadcast_to_session(self, session_id: str, message: Any) -> None:
        """Send a JSON message to all connections in a session."""
        connections = self._connections.get(session_id, [])
        dead = []
        for ws in connections:
            try:
                await ws.send_text(json.dumps(message))
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.disconnect(ws, session_id)

    async def broadcast_all(self, message: Any) -> None:
        """Send a JSON message to every connected client."""
        for session_id in list(self._connections.keys()):
            await self.broadcast_to_session(session_id, message)


# Single instance — imported by routers and background tasks
manager = ConnectionManager()
