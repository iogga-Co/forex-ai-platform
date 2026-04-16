"""
Period diagnosis — AI-powered analysis of a losing / underperforming window.

Given trades in a date range and (optionally) concurrent news events, calls
Claude and returns a structured verdict with patterns and recommendations.
"""

import json
import logging
from typing import Any

from ai.claude_client import get_full_response

logger = logging.getLogger(__name__)


async def diagnose_period(
    strategy_name: str,
    pair: str,
    timeframe: str,
    trades: list[dict[str, Any]],
    news_events: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    if len(trades) < 2:
        return {
            "summary": "Not enough trades in this window for a meaningful analysis.",
            "patterns": [],
            "verdict": "inconclusive",
            "recommendation": "Widen the selected period or choose a different window.",
        }

    prompt = _build_prompt(strategy_name, pair, timeframe, trades, news_events or [])
    raw = await get_full_response([{"role": "user", "content": prompt}])
    return _parse_response(raw)


def _build_prompt(
    strategy_name: str,
    pair: str,
    timeframe: str,
    trades: list[dict[str, Any]],
    news_events: list[dict[str, Any]],
) -> str:
    wins   = [t for t in trades if t["pnl"] is not None and float(t["pnl"]) > 0]
    losses = [t for t in trades if t["pnl"] is not None and float(t["pnl"]) <= 0]

    period_start = trades[0]["entry_time"] if trades else "?"
    period_end   = trades[-1]["exit_time"]  if trades else "?"

    trade_lines = "\n".join(
        f"  {t['entry_time']} | {t['direction']:5s} | in {t['entry_price']:.5f} out {t['exit_price']:.5f}"
        f" | P&L ${float(t['pnl']):.2f} | {t['duration_min']:.0f} min"
        for t in trades
    )

    news_section = ""
    if news_events:
        news_lines = "\n".join(
            f"  {e['event_time']} | {e['currency']:3s} | {e['title']} [{e['impact']}]"
            f" | forecast {e.get('forecast') or '—'} actual {e.get('actual') or 'pending'}"
            for e in news_events
        )
        news_section = f"""
High-impact news events during this period (±30 min of trades):
{news_lines}
"""

    return f"""You are a quantitative trading analyst reviewing a specific time window in a forex backtest.

Strategy: {strategy_name} | Pair: {pair} | Timeframe: {timeframe}
Period: {period_start} → {period_end}

Trades in this window ({len(trades)} total, {len(wins)} wins, {len(losses)} losses):
{trade_lines}
{news_section}
Analyze this window and answer:
1. Were losses concentrated at a specific time of day or day of week?
2. Was there a directional bias (mostly longs lost, or mostly shorts)?
3. Do losses correlate with any news events in the window? (if news data provided)
4. Is this consistent with overall strategy variance (statistical outlier) or a sign of structural/edge-decay issues?
5. What would you recommend the trader investigate or change?

Verdicts:
- "outlier": results are within normal statistical variance, no structural issue
- "edge_decay": the strategy's edge appears to be weakening specifically in this window
- "structural": a specific, identifiable condition (time, direction, news) is causing the underperformance
- "inconclusive": insufficient data or no clear pattern

Respond ONLY with valid JSON — no markdown fences, no explanation outside the JSON:
{{
  "summary": "1-2 sentence plain-English summary of what happened in this window",
  "patterns": [
    {{
      "label": "Category (e.g. Time of day, Direction bias, News correlation)",
      "finding": "Specific finding citing numbers from the trade data."
    }}
  ],
  "verdict": "structural" | "edge_decay" | "outlier" | "inconclusive",
  "recommendation": "1-2 sentence actionable recommendation for the trader."
}}"""


def _parse_response(raw: str) -> dict[str, Any]:
    text = raw.strip()

    # Strip markdown fences if present
    if text.startswith("```"):
        lines = text.split("\n")
        inner = lines[1:] if len(lines) > 1 else lines
        if inner and inner[-1].strip() == "```":
            inner = inner[:-1]
        text = "\n".join(inner).strip()

    try:
        data = json.loads(text)
        # Validate required keys
        for key in ("summary", "patterns", "verdict", "recommendation"):
            if key not in data:
                raise ValueError(f"Missing key: {key}")
        # Ensure patterns is a list of dicts with label + finding
        data["patterns"] = [
            p for p in data.get("patterns", [])
            if isinstance(p, dict) and "label" in p and "finding" in p
        ]
        return data
    except Exception as exc:
        logger.warning(
            "Period diagnosis parse failed: %s | raw (first 300 chars): %.300s",
            exc, raw,
        )
        return {
            "summary": "Analysis could not be parsed.",
            "patterns": [],
            "verdict": "inconclusive",
            "recommendation": "Please try again.",
        }
