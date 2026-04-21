"""
Indicator Lab AI analysis agent.

Accepts the current chart state (indicators, conditions, signal count, pair,
timeframe) and returns a brief analysis + up to 3 structured improvement
suggestions via Claude tool use.
"""

from __future__ import annotations

import logging

import anthropic

from core.config import settings

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Tools
# ---------------------------------------------------------------------------
_TOOLS: list[dict] = [
    {
        "name": "add_indicator",
        "description": "Suggest adding a new indicator to the chart to improve signal quality.",
        "input_schema": {
            "type": "object",
            "properties": {
                "type":   {"type": "string", "enum": ["EMA","SMA","BB","RSI","MACD","ADX","STOCH","ATR"]},
                "params": {"type": "object", "description": "Indicator params, e.g. {period: 20} or {fast: 12, slow: 26, signal_period: 9}"},
                "reason": {"type": "string", "description": "One sentence explanation"},
            },
            "required": ["type", "params", "reason"],
        },
    },
    {
        "name": "set_param",
        "description": "Suggest modifying a parameter of an existing indicator.",
        "input_schema": {
            "type": "object",
            "properties": {
                "indicator_type": {"type": "string"},
                "param":          {"type": "string", "description": "e.g. period, fast, slow, std_dev"},
                "value":          {"type": "number"},
                "reason":         {"type": "string"},
            },
            "required": ["indicator_type", "param", "value", "reason"],
        },
    },
    {
        "name": "add_condition",
        "description": "Suggest adding a signal entry condition.",
        "input_schema": {
            "type": "object",
            "properties": {
                "indicator": {"type": "string"},
                "operator":  {"type": "string", "enum": [">","<","price_above","price_below","crossed_above","crossed_below"]},
                "period":    {"type": "integer"},
                "value":     {"type": "number", "description": "Required for > and < operators"},
                "reason":    {"type": "string"},
            },
            "required": ["indicator", "operator", "period", "reason"],
        },
    },
]


def _describe_indicators(indicators: list[dict]) -> str:
    if not indicators:
        return "None"
    lines = []
    for ind in indicators:
        t = ind.get("type", "?")
        p = ind.get("params", {})
        if t == "MACD":
            lines.append(f"MACD(fast={p.get('fast',12)}, slow={p.get('slow',26)}, signal={p.get('signal_period',9)})")
        elif t == "BB":
            lines.append(f"BB(period={p.get('period',20)}, std_dev={p.get('std_dev',2.0)})")
        elif t == "STOCH":
            lines.append(f"STOCH(period={p.get('period',14)}, k_smooth={p.get('k_smooth',3)}, d_period={p.get('d_period',3)})")
        else:
            lines.append(f"{t}(period={p.get('period','?')})")
    return ", ".join(lines)


def _describe_conditions(conditions: list[dict]) -> str:
    if not conditions:
        return "None"
    parts = []
    for c in conditions:
        op = c.get("operator", "?")
        val = f" {c.get('value')}" if op in (">", "<") else ""
        parts.append(f"{c.get('indicator','?')}({c.get('period','?')}) {op}{val}")
    return " AND ".join(parts)


async def analyze_chart(
    pair: str,
    timeframe: str,
    indicators: list[dict],
    conditions: list[dict],
    signal_count: int,
    model: str = "claude-sonnet-4-6",
) -> dict:
    """
    Call Claude with tool use to analyse the current chart setup.

    Returns:
        {
          "text": "Brief analysis text",
          "suggestions": [
            {"tool": "add_indicator"|"set_param"|"add_condition",
             "label": "Human-readable label",
             "payload": {...tool input...}}
          ]
        }
    """
    ind_desc  = _describe_indicators(indicators)
    cond_desc = _describe_conditions(conditions)
    freq_note = (
        f"Signal frequency: approximately {signal_count} signals in the loaded period."
        if signal_count > 0 else "No signal conditions defined yet."
    )

    prompt = f"""You are a concise forex trading indicator analyst.

Pair: {pair} | Timeframe: {timeframe}
Current indicators: {ind_desc}
Signal conditions: {cond_desc}
{freq_note}

Provide a 2–3 sentence analysis of this setup. Then use the tools to suggest \
exactly 2–3 specific improvements (add indicators, tweak parameters, or add \
conditions). Be concrete and actionable. Do not repeat suggestions already present."""

    client = anthropic.AsyncAnthropic(api_key=settings.claude_api_key)

    try:
        response = await client.messages.create(
            model=model,
            max_tokens=1024,
            tools=_TOOLS,  # type: ignore[arg-type]
            messages=[{"role": "user", "content": prompt}],
        )
    except Exception as exc:
        logger.error("Lab agent Claude call failed: %s", exc)
        raise

    # Extract text and tool calls from the response
    text_parts = []
    suggestions = []

    for block in response.content:
        if block.type == "text":
            text_parts.append(block.text)
        elif block.type == "tool_use":
            tool_input = dict(block.input)  # type: ignore[arg-type]
            reason = tool_input.pop("reason", "")
            label  = _make_label(block.name, tool_input, reason)
            suggestions.append({
                "tool":    block.name,
                "label":   label,
                "reason":  reason,
                "payload": tool_input,
            })

    return {
        "text":        " ".join(text_parts).strip(),
        "suggestions": suggestions,
    }


def _make_label(tool: str, payload: dict, reason: str) -> str:
    if tool == "add_indicator":
        t = payload.get("type", "?")
        p = payload.get("params", {})
        param_str = ", ".join(f"{k}={v}" for k, v in p.items())
        return f"Add {t}({param_str})"
    if tool == "set_param":
        return f"Change {payload.get('indicator_type','?')} {payload.get('param','?')} → {payload.get('value','?')}"
    if tool == "add_condition":
        op  = payload.get("operator", "?")
        val = f" {payload.get('value')}" if op in (">", "<") else ""
        return f"Condition: {payload.get('indicator','?')}({payload.get('period','?')}) {op}{val}"
    return tool
