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
        import ai.claude_client as _claude
        return await _claude.get_full_response(messages, feature=feature)  # type: ignore[arg-type]
    if provider == "openai":
        import ai.openai_client as _openai
        return await _openai.get_full_response(messages, model=model, feature=feature)
    import ai.gemini_client as _gemini
    return await _gemini.get_full_response(messages, model=model, feature=feature)


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
        import ai.claude_client as _claude
        async for chunk in _claude.stream_chat(messages, extra_system_prompt=extra_system_prompt, feature=feature):  # type: ignore[arg-type]
            yield chunk
        return

    # Non-Claude: inject system prompt as a leading system message
    import ai.claude_client as _claude
    system = _claude._SYSTEM_PROMPT
    if extra_system_prompt.strip():
        system += f"\n\n## Additional instructions from the user\n{extra_system_prompt.strip()}"

    full_messages = [{"role": "system", "content": system}] + list(messages)

    if _provider(model) == "openai":
        import ai.openai_client as _openai
        async for chunk in _openai.stream_chat(full_messages, model=model, feature=feature):
            yield chunk
    else:
        import ai.gemini_client as _gemini
        async for chunk in _gemini.stream_chat(full_messages, model=model, feature=feature):
            yield chunk
