"""
G-Optimize ranking agent — analyses machine-tested strategies and recommends
the strongest 2-3 candidates for live deployment consideration.
"""

import json
import logging
from typing import Any

from ai.model_router import get_full_response

logger = logging.getLogger(__name__)

_MIN_TRADES_FOR_ANALYSIS = 50


# ---------------------------------------------------------------------------
# IR → human-readable helpers (mirrors strategyLabels.ts)
# ---------------------------------------------------------------------------

def _cond_label(c: dict) -> str:
    ind = c.get("indicator", "?")
    op  = c.get("operator", "?")
    val = c.get("value")

    if ind == "MACD":
        params = f"{c.get('fast')}/{c.get('slow')}/{c.get('signal_period')}"
        if op in ("crossed_above", "cross_above"):
            return f"MACD ({params}) crosses above signal"
        if op in ("crossed_below", "cross_below"):
            return f"MACD ({params}) crosses below signal"
        return f"MACD ({params}) {op} {val}"

    if ind == "BB":
        comp  = c.get("component", "middle")
        sigma = c.get("std_dev", 2.0)
        if op == "price_above": return f"Price above {comp} BB ({c.get('period')}, {sigma}σ)"
        if op == "price_below": return f"Price below {comp} BB ({c.get('period')}, {sigma}σ)"
        return f"BB {comp} ({c.get('period')}) {op} {val}"

    if ind == "STOCH":
        if op in ("crossed_above",):
            return f"Stochastic K({c.get('k_smooth')}) crosses above {val}"
        if op in ("crossed_below",):
            return f"Stochastic K({c.get('k_smooth')}) crosses below {val}"
        dir_ = "above" if op in (">", ">=") else "below"
        return f"Stochastic K({c.get('k_smooth')}) {dir_} {val}"

    period = c.get("period", "?")
    if op == "price_above": return f"Price above {ind}({period})"
    if op == "price_below": return f"Price below {ind}({period})"
    if op in ("crossed_above", "cross_above"): return f"{ind}({period}) crosses above {val}"
    if op in ("crossed_below", "cross_below"): return f"{ind}({period}) crosses below {val}"
    dir_ = "above" if op in (">", ">=") else "below"
    return f"{ind}({period}) {dir_} {val}"


def _stop_label(s: dict) -> str:
    if s.get("type") == "atr":
        return f"ATR({s.get('period', 14)}) × {s.get('multiplier', '?')}"
    return f"{s.get('pips', '?')} pips"


def _strategy_block(strat: dict, index: int) -> str:
    sir     = strat.get("ir", {})
    entry   = sir.get("entry_conditions", [])
    exits   = sir.get("exit_conditions", {})
    sl      = exits.get("stop_loss", {})
    tp      = exits.get("take_profit", {})
    em      = exits.get("exit_mode", "stops_only")

    sharpe  = strat.get("sharpe")
    wr      = (strat.get("win_rate") or 0) * 100
    dd      = abs(strat.get("max_dd") or 0) * 100
    trades  = strat.get("trade_count") or 0
    pair    = strat.get("pair", "?")
    tf      = strat.get("timeframe", "?")
    run_id  = strat.get("run_id", "?")
    bt_id   = strat.get("backtest_run_id", "?")

    entry_lines = "\n".join(f"    • {_cond_label(c)}" for c in entry) or "    • (none)"
    exit_mode_note = "" if em == "stops_only" else f" [exit mode: {em}]"

    return (
        f"Strategy {index}: {pair} {tf} (run {run_id[:8]})\n"
        f"  ID: {bt_id}\n"
        f"  Entry:{exit_mode_note}\n{entry_lines}\n"
        f"  SL: {_stop_label(sl)}  |  TP: {_stop_label(tp)}\n"
        f"  Metrics: Sharpe={sharpe:.2f}  WR={wr:.1f}%  MaxDD={dd:.1f}%  Trades={trades}"
    )


# ---------------------------------------------------------------------------
# Prompt builder
# ---------------------------------------------------------------------------

def build_ranking_prompt(strategies: list[dict]) -> str:
    blocks = "\n\n".join(
        _strategy_block(s, i + 1) for i, s in enumerate(strategies)
    )

    # Note any cross-run pairs (same entry indicators appearing in multiple runs)
    run_ids = [s.get("run_id", "") for s in strategies]
    multi_run = len(set(run_ids)) > 1
    cross_run_note = (
        "\nNote: strategies come from multiple G-Optimize runs. "
        "The same indicator combination appearing in independent runs is a robustness signal."
        if multi_run else ""
    )

    return f"""You are a quantitative trading analyst reviewing {len(strategies)} machine-tested forex strategies from G-Optimize automated discovery.{cross_run_note}

Your task:
1. Identify the 2–3 strongest candidates for live deployment consideration.
2. Explain what makes each stand out vs the rest of the set (cite specific Sharpe, WR, MaxDD numbers).
3. Flag any concerns: directional bias, single-pair only, concentrated drawdown periods, high DD.
4. Note cross-run consistency where applicable — the same indicator combo producing similar Sharpe across independent runs is a robustness signal.
5. For each recommendation, suggest one specific thing to refine in the Co-Pilot before live deployment.

Respond ONLY with valid JSON, no markdown fences, no explanation outside the JSON:
{{
  "recommendations": [
    {{
      "rank": 1,
      "backtest_run_id": "<exact ID from strategies above>",
      "summary": "<one-line summary: indicator combo + pair + key metric>",
      "rationale": "<2-4 sentences explaining the edge and why it stands out>",
      "suggested_refinement": "<one specific Co-Pilot refinement suggestion>"
    }}
  ],
  "skipped_reason": "<brief note if any strategies were borderline or not recommended>"
}}

Strategies:

{blocks}"""


# ---------------------------------------------------------------------------
# Response parser
# ---------------------------------------------------------------------------

def parse_ranking_response(raw: str) -> dict[str, Any]:
    text = raw.strip()
    if text.startswith("```"):
        lines = text.split("\n")
        inner = lines[1:] if len(lines) > 1 else lines
        if inner and inner[-1].strip() == "```":
            inner = inner[:-1]
        text = "\n".join(inner).strip()

    try:
        data = json.loads(text)
        recs = data.get("recommendations", [])
        required = ("rank", "backtest_run_id", "summary", "rationale", "suggested_refinement")
        valid = [r for r in recs if all(k in r for k in required)][:3]
        return {
            "recommendations": valid,
            "skipped":         [],
            "skipped_reason":  data.get("skipped_reason", ""),
        }
    except Exception as exc:
        logger.warning(
            "G-Optimize ranking parse failed: %s | raw (first 300 chars): %.300s",
            exc, raw,
        )
        return {"recommendations": [], "skipped": [], "skipped_reason": "Parse error — raw response logged."}


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------

async def analyze_and_rank(
    strategies: list[dict],
    model: str = "claude-sonnet-4-6",
) -> dict[str, Any]:
    """
    Rank a list of G-Optimize strategies. Strategies with < MIN_TRADES_FOR_ANALYSIS
    trades are excluded from the AI prompt and reported in the `skipped` list.

    Returns:
      {
        "recommendations": [...],
        "skipped": ["uuid1", ...],
        "skipped_reason": "..."
      }
    """
    # Partition: below minimum trade count → skipped
    eligible = [s for s in strategies if (s.get("trade_count") or 0) >= _MIN_TRADES_FOR_ANALYSIS]
    skipped  = [s["backtest_run_id"] for s in strategies if (s.get("trade_count") or 0) < _MIN_TRADES_FOR_ANALYSIS]

    if not eligible:
        return {
            "recommendations": [],
            "skipped":         skipped,
            "skipped_reason":  f"All {len(strategies)} strategies have fewer than {_MIN_TRADES_FOR_ANALYSIS} trades (minimum for statistical confidence).",
        }

    prompt  = build_ranking_prompt(eligible)
    raw     = await get_full_response(
        [{"role": "user", "content": prompt}],
        model=model,
        feature="g_optimize_ranking",
    )
    result  = parse_ranking_response(raw)
    result["skipped"] = skipped + result.get("skipped", [])
    if skipped and not result["skipped_reason"]:
        result["skipped_reason"] = f"Skipped {len(skipped)} strategies with < {_MIN_TRADES_FOR_ANALYSIS} trades."

    logger.info(
        "G-Optimize ranking: %d strategies analysed, %d recommendations, %d skipped",
        len(eligible), len(result["recommendations"]), len(skipped),
    )
    return result
