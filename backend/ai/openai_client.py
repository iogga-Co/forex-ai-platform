"""
OpenAI client.

Mirrors the interface of claude_client.py / gemini_client.py so callers
can swap models without changing their own code:

  get_full_response(messages, feature)  →  str
  stream_chat(messages, feature)        →  AsyncIterator[str]

Messages are passed as Anthropic-style dicts:
  [{"role": "user"|"assistant", "content": "..."}]

These are compatible with the OpenAI message format directly.
"""

import logging
from collections.abc import AsyncIterator

from openai import AsyncOpenAI

from ai.usage import log_usage
from core.config import settings

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Client singleton
# ---------------------------------------------------------------------------
_client: AsyncOpenAI | None = None


def _get_client() -> AsyncOpenAI:
    global _client
    if _client is None:
        _client = AsyncOpenAI(api_key=settings.openai_api_key)
    return _client


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

async def get_full_response(
    messages: list[dict],
    model: str = "gpt-4o",
    feature: str = "unknown",
) -> str:
    """Non-streaming OpenAI response. Returns complete text."""
    client = _get_client()
    try:
        response = await client.chat.completions.create(
            model=model,
            messages=messages,  # type: ignore[arg-type]
            max_tokens=4096,
        )
        text = response.choices[0].message.content or ""
        if response.usage:
            await log_usage(
                model,
                response.usage.prompt_tokens,
                response.usage.completion_tokens,
                feature,
            )
        return text
    except Exception as exc:
        logger.error("OpenAI API error: %s", exc)
        raise


async def stream_chat(
    messages: list[dict],
    model: str = "gpt-4o",
    feature: str = "copilot",
) -> AsyncIterator[str]:
    """Streaming OpenAI response. Yields text deltas."""
    client = _get_client()
    total_input = 0
    total_output = 0
    try:
        async with client.chat.completions.stream(
            model=model,
            messages=messages,  # type: ignore[arg-type]
            max_tokens=4096,
        ) as stream:
            async for event in stream:
                for choice in event.choices:
                    delta = choice.delta.content
                    if delta:
                        yield delta
            # Capture usage from the final completion
            try:
                final = await stream.get_final_completion()
                if final.usage:
                    total_input = final.usage.prompt_tokens
                    total_output = final.usage.completion_tokens
            except Exception:
                pass
    finally:
        if total_input or total_output:
            try:
                await log_usage(model, total_input, total_output, feature)
            except Exception:
                pass
