"""
Google Gemini AI client.

Mirrors the interface of claude_client.py so callers can swap models
without changing their own code:

  get_full_response(messages, feature)  →  str
  stream_chat(messages, feature)        →  AsyncIterator[str]

Messages are passed as Anthropic-style dicts:
  [{"role": "user"|"assistant", "content": "..."}]

These are converted internally to the Gemini conversation format.
"""

import logging
from collections.abc import AsyncIterator

from google import genai
from google.genai import types as gtypes

from ai.usage import log_usage
from core.config import settings

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Client singleton
# ---------------------------------------------------------------------------
_client: genai.Client | None = None


def _get_client() -> genai.Client:
    global _client
    if _client is None:
        _client = genai.Client(api_key=settings.gemini_api_key)
    return _client


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _to_gemini_contents(messages: list[dict]) -> list[gtypes.Content]:
    """Convert Anthropic-style message list to Gemini Content objects."""
    contents = []
    for m in messages:
        role = "user" if m["role"] == "user" else "model"
        contents.append(
            gtypes.Content(
                role=role,
                parts=[gtypes.Part(text=m["content"])],
            )
        )
    return contents


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

async def get_full_response(
    messages: list[dict],
    model: str = "gemini-2.5-pro",
    feature: str = "unknown",
) -> str:
    """Non-streaming Gemini response. Returns complete text."""
    client = _get_client()
    contents = _to_gemini_contents(messages)
    try:
        response = await client.aio.models.generate_content(
            model=model,
            contents=contents,
            config=gtypes.GenerateContentConfig(max_output_tokens=4096),
        )
        text = response.text or ""
        # Log usage if available
        if response.usage_metadata:
            m = response.usage_metadata
            await log_usage(
                model,
                m.prompt_token_count or 0,
                m.candidates_token_count or 0,
                feature,
            )
        return text
    except Exception as exc:
        logger.error("Gemini API error: %s", exc)
        raise


async def stream_chat(
    messages: list[dict],
    model: str = "gemini-2.0-flash",
    feature: str = "copilot",
) -> AsyncIterator[str]:
    """Streaming Gemini response. Yields text deltas."""
    client = _get_client()
    contents = _to_gemini_contents(messages)
    total_input = 0
    total_output = 0
    try:
        async for chunk in await client.aio.models.generate_content_stream(
            model=model,
            contents=contents,
            config=gtypes.GenerateContentConfig(max_output_tokens=4096),
        ):
            if chunk.text:
                yield chunk.text
            if chunk.usage_metadata:
                m = chunk.usage_metadata
                total_input  = m.prompt_token_count or total_input
                total_output = m.candidates_token_count or total_output
    finally:
        if total_input or total_output:
            try:
                await log_usage(model, total_input, total_output, feature)
            except Exception:
                pass
