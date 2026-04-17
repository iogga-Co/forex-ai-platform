"""
Multi-trade pattern analysis — AI-powered.

Given pre-computed selection vs population stats, calls Claude and returns
a structured analysis with headline, patterns, verdict, and recommendation.
"""

import json
import logging
from typing import Any

from ai.claude_client import get_full_response

logger = logging.getLogger(__name__)


async def analyze_trades(
    strategy_name: str,
    pair: str,
    timeframe: str,
    stats: dict[str, Any],
) -> dict[str, Any]:
    prompt = _build_prompt(strategy_name, pair, timeframe, stats)
    raw = await get_full_response([{"role": "user", "content": prompt}], feature="trade_analysis")
    return _parse_response(raw)


def _build_prompt(
    strategy_name: str,
    pair: str,
    timeframe: str,
    stats: dict[str, Any],
) -> str:
    sel = stats["selection"]
    pop = stats["population"]

    delta_win = (sel["win_rate"] - pop["win_rate"]) * 100
    delta_pnl  = sel["avg_pnl"] - pop["avg_pnl"]

    # Top 3 hours/days by count in the selection
    by_hour = sel.get("by_hour", {})
    top_hours = sorted(by_hour.items(), key=lambda x: x[1]["count"], reverse=True)[:3]
    hour_lines = "\n".join(
        f"  {h}:00 UTC — {v['count']} trades, {v['win_rate']*100:.0f}% win rate"
        for h, v in top_hours
    ) or "  (no data)"

    by_dow = sel.get("by_dow", {})
    top_days = sorted(by_dow.items(), key=lambda x: x[1]["count"], reverse=True)[:3]
    day_lines = "\n".join(
        f"  {d.capitalize()} — {v['count']} trades, {v['win_rate']*100:.0f}% win rate"
        for d, v in top_days
    ) or "  (no data)"

    short_wr = sel.get("short_win_rate")
    long_wr  = sel.get("long_win_rate")

    return f"""You are a quantitative trading analyst reviewing a user-selected subset of trades from a forex backtest.

Strategy: {strategy_name} | Pair: {pair} | Timeframe: {timeframe}

Full backtest population ({pop['count']} trades):
  Win rate: {pop['win_rate']*100:.1f}%
  Avg P&L: ${pop['avg_pnl']:.2f}
  Avg loss: ${pop['avg_loss']:.2f}
  Avg R-multiple: {pop['avg_r']:.2f}
  Avg duration: {pop['avg_duration_min']:.0f} min

Selected subset ({sel['count']} trades):
  Win rate: {sel['win_rate']*100:.1f}% (vs population {pop['win_rate']*100:.1f}%, delta {delta_win:+.1f}%)
  Avg P&L: ${sel['avg_pnl']:.2f} (vs population ${pop['avg_pnl']:.2f}, delta ${delta_pnl:+.2f})
  Avg loss: ${sel.get('avg_loss', 0):.2f} (vs population ${pop['avg_loss']:.2f})
  Avg R-multiple: {sel['avg_r']:.2f}
  Avg duration: {sel['avg_duration_min']:.0f} min (vs population {pop['avg_duration_min']:.0f} min)
  Avg MAE: {sel['avg_mae']:.5f} | Avg MFE: {sel['avg_mfe']:.5f}

Direction breakdown (selection):
  Longs:  {sel['long_count']} trades, {f"{long_wr*100:.1f}%" if long_wr is not None else "N/A"} win rate
  Shorts: {sel['short_count']} trades, {f"{short_wr*100:.1f}%" if short_wr is not None else "N/A"} win rate

Time-of-day breakdown (UTC, selection):
{hour_lines}

Day-of-week breakdown (selection):
{day_lines}

Identify the 2–4 strongest patterns that distinguish this selection from the full population.
For each pattern, state: what it is, how strong the signal is, and what the trader should do.

Verdicts:
- "outlier": selection is consistent with normal variance, no structural issue
- "edge_decay": edge is weakening over time in this selection
- "structural": a specific, identifiable condition is causing the divergence
- "inconclusive": insufficient data or no clear pattern

Respond ONLY with valid JSON — no markdown fences, no explanation outside the JSON:
{{
  "headline": "1-sentence summary of the dominant pattern",
  "patterns": [
    {{
      "label": "Category (e.g. Time of day, Direction bias, Duration)",
      "finding": "Specific finding citing numbers from the data.",
      "strength": "strong" | "moderate" | "weak",
      "recommendation": "Specific actionable recommendation."
    }}
  ],
  "verdict": "structural" | "edge_decay" | "outlier" | "inconclusive",
  "recommendation": "1-2 sentence overall recommendation."
}}"""


def _parse_response(raw: str) -> dict[str, Any]:
    text = raw.strip()

    if text.startswith("```"):
        lines = text.split("\n")
        inner = lines[1:] if len(lines) > 1 else lines
        if inner and inner[-1].strip() == "```":
            inner = inner[:-1]
        text = "\n".join(inner).strip()

    try:
        data = json.loads(text)
        # Validate required top-level keys
        if "headline" not in data or "patterns" not in data:
            raise ValueError("Missing required keys")
        # Validate each pattern
        required = ("label", "finding", "strength", "recommendation")
        data["patterns"] = [
            p for p in data.get("patterns", []) if all(k in p for k in required)
        ]
        return data
    except Exception as exc:
        logger.warning(
            "Trade analysis parse failed: %s | raw (first 300 chars): %.300s",
            exc, raw,
        )
        return {
            "headline": "Analysis could not be parsed.",
            "patterns": [],
            "verdict": "inconclusive",
            "recommendation": "Please try again.",
        }
