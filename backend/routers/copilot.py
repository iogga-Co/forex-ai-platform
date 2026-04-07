"""
AI Co-Pilot endpoints — Phase 2.

POST /api/copilot/chat
    Accepts a user message and session_id.
    1. Stores the user turn in conversation_turns (with embedding).
    2. Retrieves relevant context via hybrid RAG.
    3. Streams Claude's response as Server-Sent Events (SSE).
    4. After streaming, stores the assistant turn (with embedding).
    5. If Claude's response contains a ```sir block, parses and returns it
       as a final "sir" SSE event so the frontend can display the SIR inspector.

GET /api/copilot/sessions/{session_id}
    Returns the full conversation history for a session.
"""

import json
import logging
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from ai.claude_client import extract_sir_from_response, stream_chat, summarize_backtest
from ai.retrieval import retrieve_context
from ai.voyage_client import embed, embed_query
from core.auth import TokenData, get_current_user
from core.db import get_pool

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/copilot", tags=["Co-Pilot"])


# ---------------------------------------------------------------------------
# Request / Response models
# ---------------------------------------------------------------------------

class ChatRequest(BaseModel):
    session_id: UUID
    message: str
    strategy_id: UUID | None = None  # strategy currently open in the inspector


class TurnResponse(BaseModel):
    id: UUID
    session_id: UUID
    role: str
    content: str
    strategy_id: UUID | None
    created_at: str


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _sse(event: str, data: str) -> str:
    """Format a Server-Sent Event line."""
    return f"event: {event}\ndata: {data}\n\n"


async def _store_turn(
    conn,
    session_id: UUID,
    role: str,
    content: str,
    strategy_id: UUID | None,
    embedding: list[float] | None,
) -> UUID:
    """Insert a conversation turn and return its id."""
    embedding_val = (
        "[" + ",".join(str(x) for x in embedding) + "]"
        if embedding
        else None
    )
    row = await conn.fetchrow(
        """
        INSERT INTO conversation_turns (session_id, role, content, strategy_id, embedding)
        VALUES ($1, $2, $3, $4, $5::vector)
        RETURNING id
        """,
        session_id,
        role,
        content,
        strategy_id,
        embedding_val,
    )
    return row["id"]


# ---------------------------------------------------------------------------
# POST /api/copilot/chat
# ---------------------------------------------------------------------------

@router.post("/chat")
async def chat(
    payload: ChatRequest,
    _: Annotated[TokenData | None, Depends(get_current_user)] = None,
) -> StreamingResponse:
    """
    Stream a Co-Pilot response as SSE.

    Events emitted:
        text      — incremental text delta from Claude
        sir       — JSON string of a validated SIR (if Claude proposed one)
        error     — error message string
        done      — empty, signals end of stream
    """
    async def generate():
        pool = await get_pool()

        try:
            # 1. Embed the user's message for storage + retrieval
            user_embedding = await embed(payload.message)
            query_embedding = await embed_query(payload.message)

            async with pool.acquire() as conn:
                # 2. Store user turn
                await _store_turn(
                    conn,
                    session_id=payload.session_id,
                    role="user",
                    content=payload.message,
                    strategy_id=payload.strategy_id,
                    embedding=user_embedding,
                )

                # 3. Retrieve context via hybrid RAG
                context_chunks = await retrieve_context(
                    query_embedding=query_embedding,
                    query_text=payload.message,
                    conn=conn,
                    session_id=str(payload.session_id),
                )

                # 4. Fetch conversation history for this session (last 20 turns)
                history_rows = await conn.fetch(
                    """
                    SELECT role, content
                    FROM conversation_turns
                    WHERE session_id = $1
                    ORDER BY created_at DESC
                    LIMIT 20
                    """,
                    payload.session_id,
                )

            # Build messages list: inject context as a system note, then history
            messages: list[dict[str, str]] = []

            if context_chunks:
                context_text = "\n\n".join(c["content"] for c in context_chunks)
                messages.append({
                    "role": "user",
                    "content": (
                        f"[CONTEXT from prior sessions — use this to inform your response]\n"
                        f"{context_text}\n\n"
                        f"[END CONTEXT]\n\nNow respond to my message below."
                    ),
                })
                messages.append({
                    "role": "assistant",
                    "content": "Understood, I have the context. Please go ahead.",
                })

            # Append conversation history in chronological order
            for row in reversed(history_rows):
                messages.append({"role": row["role"], "content": row["content"]})

            # 5. Stream Claude's response
            full_response: list[str] = []
            async for chunk in stream_chat(messages):
                full_response.append(chunk)
                yield _sse("text", json.dumps(chunk))

            response_text = "".join(full_response)

            # 6. Check for SIR in response
            sir = extract_sir_from_response(response_text)
            if sir:
                yield _sse("sir", sir.model_dump_json())

            # 7. Store assistant turn with embedding
            assistant_embedding = await embed(response_text)
            async with pool.acquire() as conn:
                await _store_turn(
                    conn,
                    session_id=payload.session_id,
                    role="assistant",
                    content=response_text,
                    strategy_id=payload.strategy_id,
                    embedding=assistant_embedding,
                )

        except Exception as exc:
            logger.exception("Co-Pilot chat error: %s", exc)
            yield _sse("error", json.dumps(str(exc)))

        finally:
            yield _sse("done", "")

    return StreamingResponse(generate(), media_type="text/event-stream")


# ---------------------------------------------------------------------------
# GET /api/copilot/sessions/{session_id}
# ---------------------------------------------------------------------------

@router.get("/sessions/{session_id}", response_model=list[TurnResponse])
async def get_session(
    session_id: UUID,
    _: Annotated[TokenData | None, Depends(get_current_user)] = None,
) -> list[TurnResponse]:
    """Return all conversation turns for a session, in chronological order."""
    pool = await get_pool()
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT id, session_id, role, content, strategy_id, created_at
            FROM conversation_turns
            WHERE session_id = $1
            ORDER BY created_at ASC
            """,
            session_id,
        )

    if not rows:
        raise HTTPException(status_code=404, detail="Session not found")

    return [
        TurnResponse(
            id=r["id"],
            session_id=r["session_id"],
            role=r["role"],
            content=r["content"],
            strategy_id=r["strategy_id"],
            created_at=r["created_at"].isoformat(),
        )
        for r in rows
    ]
