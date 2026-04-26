"""
Indicator Lab AI agent.
Uses Claude tool use to suggest indicator configurations based on user chat.
"""
from __future__ import annotations

import logging

import anthropic

from ai.usage import log_usage
from core.config import settings

logger = logging.getLogger(__name__)

_TOOL = {
    "name": "set_indicator_config",
    "description": (
        "Set the indicator configuration in the Lab builder. "
        "Call this whenever you suggest a new or modified setup."
    ),
    "input_schema": {
        "type": "object",
        "required": ["indicators"],
        "properties": {
            "indicators": {
                "type": "array",
                "description": "Indicators to display on the chart.",
                "items": {
                    "type": "object",
                    "required": ["type", "params"],
                    "properties": {
                        "type": {
                            "type": "string",
                            "enum": ["EMA", "SMA", "BB", "RSI", "MACD", "ADX", "STOCH", "ATR"],
                        },
                        "params": {
                            "type": "object",
                            "description": (
                                "EMA/SMA/RSI/ADX/ATR: {period}. "
                                "MACD: {fast, slow, signal_period}. "
                                "BB: {period, std_dev}. "
                                "STOCH: {period, k_smooth, d_period}."
                            ),
                        },
                        "color": {"type": "string", "description": "Hex color for overlay indicators."},
                    },
                },
            },
            "conditions": {
                "type": "array",
                "description": "Entry signal conditions (optional).",
                "items": {
                    "type": "object",
                    "required": ["indicator", "operator", "period"],
                    "properties": {
                        "indicator": {"type": "string"},
                        "operator": {
                            "type": "string",
                            "enum": [">", "<", "price_above", "price_below", "crossed_above", "crossed_below"],
                        },
                        "period": {"type": "integer"},
                        "value": {"type": "number"},
                    },
                },
            },
        },
    },
}

_SYSTEM = """\
You are an expert algorithmic forex trading assistant helping users build indicator setups in the Indicator Lab.

When the user asks to create, modify, or discuss indicators, always call `set_indicator_config` with your suggested setup.
Also include a brief text response explaining the trading logic behind your choices.

Supported indicators:
- EMA(period), SMA(period) — overlay moving averages
- BB(period, std_dev) — Bollinger Bands (overlay)
- RSI(period) — momentum oscillator, 0–100
- MACD(fast, slow, signal_period) — trend/momentum oscillator
- ADX(period) — trend strength, >25 signals a trend
- STOCH(period, k_smooth, d_period) — stochastic oscillator, 0–100
- ATR(period) — volatility in price units

Signal conditions: >, <, price_above, price_below, crossed_above, crossed_below

Keep text responses concise — 2–4 sentences focused on the trading logic.
"""


async def analyze(
    messages: list[dict],
    current_config: dict,
    pair: str,
    timeframe: str,
    model: str = "claude-sonnet-4-6",
) -> tuple[str, dict | None]:
    """
    Run one Lab AI conversation turn.
    Returns (text_response, ir_update | None).
    ir_update shape: {"indicators": [...], "conditions": [...]}
    """
    client = anthropic.AsyncAnthropic(api_key=settings.claude_api_key)

    inds  = current_config.get("indicators", [])
    conds = current_config.get("conditions", [])

    ctx_lines = [f"Chart: {pair} {timeframe}"]
    if inds:
        ind_str = ", ".join(
            f"{i['type']}({', '.join(str(v) for v in i.get('params', {}).values())})"
            for i in inds
        )
        ctx_lines.append(f"Active indicators: {ind_str}")
    else:
        ctx_lines.append("Active indicators: none")
    if conds:
        cond_str = ", ".join(
            f"{c['indicator']}({c.get('period', 14)}) {c['operator']}"
            f"{f' {c[\"value\"]}' if c.get('value') is not None else ''}"
            for c in conds
        )
        ctx_lines.append(f"Active conditions: {cond_str}")
    ctx = "\n".join(ctx_lines)

    api_messages: list[dict] = []
    for i, msg in enumerate(messages):
        if i == 0 and msg["role"] == "user":
            api_messages.append({"role": "user", "content": f"{ctx}\n\n{msg['content']}"})
        else:
            api_messages.append(dict(msg))

    response = await client.messages.create(
        model=model,
        max_tokens=1024,
        system=_SYSTEM,
        tools=[_TOOL],
        messages=api_messages,
    )

    await log_usage(
        model=model,
        feature="lab_analyze",
        input_tokens=response.usage.input_tokens,
        output_tokens=response.usage.output_tokens,
    )

    text = ""
    ir_update = None
    for block in response.content:
        if block.type == "text":
            text = block.text
        elif block.type == "tool_use" and block.name == "set_indicator_config":
            ir_update = dict(block.input)

    if ir_update is not None and not text:
        text = "Indicator configuration updated."

    return text, ir_update
