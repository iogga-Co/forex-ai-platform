"""
AI model router — dispatches get_full_response / stream_chat to the right
provider (Anthropic, OpenAI, Google) based on the model ID prefix.

Callers import from here instead of a specific client so the user's
active model selection is honoured transparently.
"""

from collections.abc import AsyncIterator


def _provider(model: str) -> str:
    if model.startswith("claude-"):
        return "anthropic"
    if model.startswith("gpt-"):
        return "openai"
    if model.startswith("gemini-"):
        return "google"
    return "anthropic"  # safe fallback


async def get_full_response(
    messages: list[dict],
    model: str = "claude-sonnet-4-6",
    feature: str = "unknown",
) -> str:
    """Route a non-streaming AI call to the correct provider."""
    provider = _provider(model)
    if provider == "anthropic":
        from ai.claude_client import get_full_response as _fn
        return await _fn(messages, feature=feature)
    if provider == "openai":
        from ai.openai_client import get_full_response as _fn
        return await _fn(messages, model=model, feature=feature)
    # google
    from ai.gemini_client import get_full_response as _fn
    return await _fn(messages, model=model, feature=feature)


async def stream_chat_copilot(
    messages: list[dict],
    model: str = "claude-opus-4-6",
    extra_system_prompt: str = "",
    feature: str = "copilot",
) -> AsyncIterator[str]:
    """
    Route a streaming Co-Pilot call to the correct provider.

    Claude uses its own system prompt + extra_system_prompt.
    OpenAI/Gemini receive the same system prompt injected as the first message.
    """
    if _provider(model) == "anthropic":
        from ai.claude_client import stream_chat
        async for chunk in stream_chat(messages, extra_system_prompt=extra_system_prompt, feature=feature):
            yield chunk
        return

    # Non-Claude: inject system prompt as a leading system message
    from ai.claude_client import _SYSTEM_PROMPT
    system = _SYSTEM_PROMPT
    if extra_system_prompt.strip():
        system += f"\n\n## Additional instructions from the user\n{extra_system_prompt.strip()}"

    full_messages = [{"role": "system", "content": system}] + list(messages)

    if _provider(model) == "openai":
        from ai.openai_client import stream_chat as _stream
        async for chunk in _stream(full_messages, model=model, feature=feature):
            yield chunk
    else:
        from ai.gemini_client import stream_chat as _stream
        async for chunk in _stream(full_messages, model=model, feature=feature):
            yield chunk
