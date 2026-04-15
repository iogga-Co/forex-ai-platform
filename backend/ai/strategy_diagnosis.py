"""
Strategy diagnosis — AI-powered weakness identification.

Given pre-computed trade statistics for a backtest run, calls Claude
and returns up to 3 structured fix suggestions with ir_patch objects.
"""

import json
import logging
from typing import Any

from ai.claude_client import get_full_response

logger = logging.getLogger(__name__)


async def diagnose_strategy(
    strategy_name: str,
    pair: str,
    timeframe: str,
    metrics: dict[str, Any],
    trade_stats: dict[str, Any],
) -> dict[str, Any]:
    """
    Call Claude to identify the top 3 weaknesses in a backtest result
    and return structured fix suggestions with ir_patch objects.
    """
    prompt = _build_prompt(strategy_name, pair, timeframe, metrics, trade_stats)
    raw = await get_full_response([{"role": "user", "content": prompt}])
    return _parse_response(raw)


def _build_prompt(
    strategy_name: str,
    pair: str,
    timeframe: str,
    metrics: dict[str, Any],
    stats: dict[str, Any],
) -> str:
    win_rate_pct = (metrics.get("win_rate") or 0) * 100
    max_dd_pct   = abs(metrics.get("max_dd") or 0) * 100

    # Worst 3 days by win rate (minimum 3 trades to be meaningful)
    dow = stats.get("by_dow", {})
    worst_days = sorted(
        [(d, v) for d, v in dow.items() if v.get("count", 0) >= 3],
        key=lambda x: x[1]["win_rate"],
    )[:3]

    # Worst 3 hours by win rate (minimum 3 trades to be meaningful)
    hour = stats.get("by_hour", {})
    worst_hours = sorted(
        [(h, v) for h, v in hour.items() if v.get("count", 0) >= 3],
        key=lambda x: x[1]["win_rate"],
    )[:3]

    dow_lines = "\n".join(
        f"  {d.capitalize()}: {v['win_rate']*100:.0f}% win rate ({v['count']} trades)"
        for d, v in worst_days
    ) or "  (insufficient data per day)"

    hour_lines = "\n".join(
        f"  {h}:00 UTC: {v['win_rate']*100:.0f}% win rate ({v['count']} trades)"
        for h, v in worst_hours
    ) or "  (insufficient data per hour)"

    return f"""You are a quantitative trading analyst reviewing a forex strategy backtest.

Strategy: {strategy_name} | Pair: {pair} | Timeframe: {timeframe}

Metrics:
- Win rate: {win_rate_pct:.1f}%
- Max drawdown: {max_dd_pct:.1f}%
- Sharpe ratio: {metrics.get("sharpe") or "N/A"}
- Profit factor: {stats.get("profit_factor") or "N/A"}
- Total trades: {metrics.get("trade_count")}
- Stop-out rate (losses where MFE never went positive): {stats.get("stop_out_rate_pct", 0):.1f}%

Day-of-week breakdown (worst performing days):
{dow_lines}

Hour-of-day breakdown (worst performing hours, UTC):
{hour_lines}

Direction breakdown:
  Longs:  {stats.get("long_win_rate", 0)*100:.1f}% win rate ({stats.get("long_count", 0)} trades)
  Shorts: {stats.get("short_win_rate", 0)*100:.1f}% win rate ({stats.get("short_count", 0)} trades)

Avg R-multiple — winners: {stats.get("avg_win_r") or "N/A"} | losers: {stats.get("avg_loss_r") or "N/A"}

Identify exactly 3 concrete improvements. Each must be specific, data-driven, and actionable.
For each, provide:
1. A plain-English finding (1 sentence, cite specific numbers from the data above)
2. An action_label (short button text, ≤ 5 words, e.g. "Apply Monday Filter")
3. An ir_patch: a partial SIR JSON object that applies the fix

Valid ir_patch structures (use only these forms):
- Exclude a day:           {{"filters": {{"exclude_days": ["monday"]}}}}
- Change session:          {{"filters": {{"session": "london_open"}}}}
- Increase ATR SL mult:    {{"exit_conditions": {{"stop_loss": {{"type": "atr", "period": 14, "multiplier": 2.0}}}}}}
- Increase ATR TP mult:    {{"exit_conditions": {{"take_profit": {{"type": "atr", "period": 14, "multiplier": 3.0}}}}}}
- Raise RSI threshold:     {{"entry_conditions": [<full updated entry_conditions array>]}}

Respond ONLY with valid JSON — no markdown fences, no explanation outside the JSON:
{{
  "findings": [
    {{
      "id": "snake_case_identifier",
      "finding": "Plain English finding with specific numbers.",
      "action_label": "Short button label",
      "ir_patch": {{ ... partial SIR ... }},
      "confidence": "high" | "medium" | "low"
    }}
  ]
}}"""


def _parse_response(raw: str) -> dict[str, Any]:
    """Extract and validate JSON findings from Claude's response."""
    text = raw.strip()

    # Strip markdown fences if present
    if text.startswith("```"):
        lines = text.split("\n")
        # Remove first line (```json or ```) and last line (```)
        inner = lines[1:] if len(lines) > 1 else lines
        if inner and inner[-1].strip() == "```":
            inner = inner[:-1]
        text = "\n".join(inner).strip()

    try:
        data = json.loads(text)
        findings = data.get("findings", [])
        required = ("id", "finding", "action_label", "ir_patch")
        valid = [f for f in findings if all(k in f for k in required)]
        return {"findings": valid[:3]}
    except Exception as exc:
        logger.warning(
            "Strategy diagnosis parse failed: %s | raw response (first 300 chars): %.300s",
            exc, raw,
        )
        return {"findings": []}
