"""
Claude AI client — Phase 2 AI Co-Pilot.

Responsibilities:
- Hold the system prompt (SIR schema, indicator reference, risk rules)
- Stream conversational responses via the Anthropic API
- Generate structured SIR JSON from a conversation
- Summarise backtest results in plain English
"""

import json
import logging
import re
from collections.abc import AsyncIterator
from typing import Any

import anthropic
from anthropic.types import MessageParam

from core.config import settings
from engine.sir import StrategyIR

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# System prompt
# ---------------------------------------------------------------------------
_SYSTEM_PROMPT = """\
You are an expert algorithmic forex trading assistant embedded in a trading platform.
Your job is to help traders design, refine, and evaluate trading strategies through natural conversation.

## Strategy Intermediate Representation (SIR)

All strategies are stored as a JSON document called the Strategy IR (SIR).
When the user wants to create or modify a strategy you MUST produce a valid SIR block.

SIR schema:
```json
{
  "entry_conditions": [
    {
      "indicator": "<RSI|EMA|SMA|MACD|BB|ATR|ADX|STOCH>",
      "period": <integer 1-500>,
      "operator": "<> | < | >= | <= | == | crossed_above | crossed_below | price_above | price_below>",
      "value": <float, required for threshold operators, omit for price_above/price_below>,
      "component": "<upper|middle|lower for BB> | <line|signal|histogram for MACD> | <k|d for STOCH> (optional)",
      "fast": <int, MACD only>,
      "slow": <int, MACD only>,
      "signal_period": <int, MACD only>,
      "std_dev": <float, BB only>,
      "k_smooth": <int, STOCH only>,
      "d_period": <int, STOCH only>
    }
  ],
  "exit_conditions": {
    "stop_loss":   { "type": "<atr|fixed_pips|percent>", "period": <int>, "multiplier": <float> },
    "take_profit": { "type": "<atr|fixed_pips|percent>", "period": <int>, "multiplier": <float> }
  },
  "filters": {
    "exclude_days": ["<Monday|Tuesday|Wednesday|Thursday|Friday>"],
    "session": "<london_open|new_york_open|asian_session|all>"
  },
  "position_sizing": {
    "risk_per_trade_pct": <float 0-10>,
    "max_size_units": <integer>
  },
  "metadata": {
    "description": "<one-line human-readable summary of the strategy>"
  }
}
```

## Rules

- Always include at least one entry condition.
- stop_loss and take_profit are both required.
- For ATR stops: both `period` and `multiplier` are required.
- For fixed_pips stops: `pips` is required.
- For percent stops: `percent` is required (e.g. 0.01 = 1%).
- price_above / price_below operators do not use a `value` field.
- Threshold operators (>, <, >=, <=, ==, crossed_above, crossed_below) require a `value` field.
- risk_per_trade_pct should never exceed 2% for conservative strategies, 5% for aggressive.
- Always include a `metadata.description` field: a concise one-line summary of the strategy (e.g. "RSI momentum with EMA trend filter, ATR exits on EURUSD 1H").

## Output format

When proposing a SIR, wrap it in a fenced JSON block with the tag `sir`:
```sir
{ ... }
```

Explain your reasoning before and/or after the SIR block.
When discussing backtest results, focus on: Sharpe ratio, max drawdown, win rate, and trade count.
Be concise. Forex traders value precision over verbosity.
"""

# ---------------------------------------------------------------------------
# Client singleton
# ---------------------------------------------------------------------------
_client: anthropic.AsyncAnthropic | None = None


def _get_client() -> anthropic.AsyncAnthropic:
    global _client
    if _client is None:
        _client = anthropic.AsyncAnthropic(api_key=settings.claude_api_key)
    return _client


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

async def stream_chat(
    messages: list[MessageParam],
    extra_system_prompt: str = "",
) -> AsyncIterator[str]:
    """
    Stream a conversational response from Claude.

    `messages` is the full conversation history:
        [{"role": "user", "content": "..."}, {"role": "assistant", "content": "..."}, ...]

    `extra_system_prompt` is appended to the base system prompt, allowing the
    user to add custom instructions per session without replacing the core SIR schema.

    Yields text deltas as they arrive.
    """
    system = _SYSTEM_PROMPT
    if extra_system_prompt.strip():
        system += f"\n\n## Additional instructions from the user\n{extra_system_prompt.strip()}"
    client = _get_client()
    async with client.messages.stream(
        model="claude-opus-4-6",
        max_tokens=4096,
        system=system,
        messages=messages,
    ) as stream:
        async for text in stream.text_stream:
            yield text


async def get_full_response(messages: list[MessageParam]) -> str:
    """
    Non-streaming version of stream_chat — returns the complete response text.
    Used for summarisation and SIR extraction where we need the full output.
    """
    chunks: list[str] = []
    async for chunk in stream_chat(messages):
        chunks.append(chunk)
    return "".join(chunks)


def extract_sir_from_response(text: str) -> StrategyIR | None:
    """
    Parse and validate a SIR JSON block from Claude's response text.
    Returns a validated StrategyIR or None if no valid SIR is found.
    """
    # Match ```sir ... ``` blocks
    match = re.search(r"```sir\s*(\{.*?\})\s*```", text, re.DOTALL)
    if not match:
        # Fallback: any fenced JSON block
        match = re.search(r"```json\s*(\{.*?\})\s*```", text, re.DOTALL)
    if not match:
        return None

    raw = match.group(1).strip()
    try:
        data = json.loads(raw)
        return StrategyIR.model_validate(data)
    except Exception as exc:
        logger.warning("SIR extraction failed: %s", exc)
        return None


async def summarize_backtest(
    metrics: dict[str, Any],
    strategy_description: str,
    pair: str,
    timeframe: str,
    period_start: str,
    period_end: str,
) -> str:
    """
    Generate a plain-English summary of a completed backtest.
    Stored in backtest_runs.summary_text for RAG retrieval.
    """
    metrics_text = "\n".join(
        f"- {k}: {v}" for k, v in metrics.items() if v is not None
    )
    prompt = (
        f"Summarise the following backtest result in 3-5 sentences. "
        f"Focus on what worked, what failed, and under what market conditions "
        f"the strategy performed best or worst.\n\n"
        f"Strategy: {strategy_description}\n"
        f"Pair: {pair} | Timeframe: {timeframe} | Period: {period_start} to {period_end}\n\n"
        f"Metrics:\n{metrics_text}"
    )
    response = await get_full_response([{"role": "user", "content": prompt}])
    return response.strip()
