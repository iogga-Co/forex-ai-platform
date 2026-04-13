"""
Optimization agent — synchronous Claude client for the optimization Celery task.

Uses Claude's tool use API instead of free-form SIR generation.
Claude can only call narrowly-typed mutation tools; the Anthropic API
enforces each tool's JSON Schema, making hallucinated fields structurally
impossible.

Safety layers (see OPTIMIZATION_TAB_PLAN.md §4):
  1. Tool use — Anthropic API enforces input schemas
  2. Pydantic StrategyIR validation + up to 3 retries with error feedback
  3. Value clamping inside apply_tool_call (defensive, even if schema holds)
  4. Degenerate detection (0 trades / unchanged results) via build_extra_context
"""

import copy
import logging
from typing import Any

import anthropic

from core.config import settings
from engine.sir import StrategyIR

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Synchronous client (Celery worker is sync)
# ---------------------------------------------------------------------------
_sync_client: anthropic.Anthropic | None = None


def _get_client() -> anthropic.Anthropic:
    global _sync_client
    if _sync_client is None:
        _sync_client = anthropic.Anthropic(api_key=settings.claude_api_key)
    return _sync_client


# ---------------------------------------------------------------------------
# Tool definitions — the only mutations Claude may request
# ---------------------------------------------------------------------------
OPTIMIZATION_TOOLS: list[dict[str, Any]] = [
    {
        "name": "set_period",
        "description": (
            "Change the lookback period for an entry condition. "
            "Use condition_index to reference the zero-based position in entry_conditions."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "condition_index": {
                    "type": "integer",
                    "minimum": 0,
                    "description": "Zero-based index into the entry_conditions array.",
                },
                "period": {
                    "type": "integer",
                    "minimum": 2,
                    "maximum": 500,
                    "description": "New lookback period.",
                },
            },
            "required": ["condition_index", "period"],
        },
    },
    {
        "name": "set_threshold",
        "description": (
            "Change the numeric comparison threshold (value field) in an entry condition. "
            "Only valid for threshold operators: >, <, >=, <=, ==, crossed_above, crossed_below."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "condition_index": {
                    "type": "integer",
                    "minimum": 0,
                    "description": "Zero-based index into the entry_conditions array.",
                },
                "value": {
                    "type": "number",
                    "description": "New threshold value (e.g. 30 for RSI oversold).",
                },
            },
            "required": ["condition_index", "value"],
        },
    },
    {
        "name": "set_operator",
        "description": "Change the comparison operator in an entry condition.",
        "input_schema": {
            "type": "object",
            "properties": {
                "condition_index": {
                    "type": "integer",
                    "minimum": 0,
                },
                "operator": {
                    "type": "string",
                    "enum": [
                        ">", "<", ">=", "<=", "==",
                        "crossed_above", "crossed_below",
                        "price_above", "price_below",
                    ],
                },
            },
            "required": ["condition_index", "operator"],
        },
    },
    {
        "name": "set_exit_multiplier",
        "description": (
            "Change the ATR multiplier for stop_loss or take_profit exit conditions. "
            "Higher multiplier = wider stop or target."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "side": {
                    "type": "string",
                    "enum": ["stop_loss", "take_profit"],
                },
                "multiplier": {
                    "type": "number",
                    "minimum": 0.1,
                    "maximum": 10.0,
                    "description": "ATR multiplier (e.g. 2.0 = stop at 2× ATR).",
                },
            },
            "required": ["side", "multiplier"],
        },
    },
    {
        "name": "set_exit_period",
        "description": "Change the ATR lookback period for stop_loss or take_profit.",
        "input_schema": {
            "type": "object",
            "properties": {
                "side": {
                    "type": "string",
                    "enum": ["stop_loss", "take_profit"],
                },
                "period": {
                    "type": "integer",
                    "minimum": 2,
                    "maximum": 200,
                },
            },
            "required": ["side", "period"],
        },
    },
    {
        "name": "set_risk_per_trade",
        "description": "Change the risk percentage per trade (position sizing).",
        "input_schema": {
            "type": "object",
            "properties": {
                "risk_pct": {
                    "type": "number",
                    "minimum": 0.1,
                    "maximum": 5.0,
                    "description": "Percentage of account to risk per trade (e.g. 1.5).",
                },
            },
            "required": ["risk_pct"],
        },
    },
]


# ---------------------------------------------------------------------------
# Tool application
# ---------------------------------------------------------------------------

def apply_tool_call(ir: dict, tool_name: str, tool_input: dict) -> dict:
    """
    Apply a single Claude tool call to a copy of the IR dict.
    Values are clamped defensively even though the tool schemas enforce ranges.
    Returns the modified copy; never mutates the original.
    """
    ir = copy.deepcopy(ir)
    conditions: list[dict] = ir.get("entry_conditions", [])

    if tool_name == "set_period":
        idx = tool_input["condition_index"]
        if 0 <= idx < len(conditions):
            conditions[idx]["period"] = max(2, min(500, int(tool_input["period"])))
        else:
            logger.warning("set_period: condition_index %d out of range (%d conditions)", idx, len(conditions))

    elif tool_name == "set_threshold":
        idx = tool_input["condition_index"]
        if 0 <= idx < len(conditions):
            conditions[idx]["value"] = float(tool_input["value"])
        else:
            logger.warning("set_threshold: condition_index %d out of range", idx)

    elif tool_name == "set_operator":
        idx = tool_input["condition_index"]
        if 0 <= idx < len(conditions):
            conditions[idx]["operator"] = tool_input["operator"]
            # price_above / price_below operators must not have a value field
            if tool_input["operator"] in ("price_above", "price_below"):
                conditions[idx].pop("value", None)
        else:
            logger.warning("set_operator: condition_index %d out of range", idx)

    elif tool_name == "set_exit_multiplier":
        side = tool_input["side"]
        mult = max(0.1, min(10.0, float(tool_input["multiplier"])))
        ir.setdefault("exit_conditions", {}).setdefault(side, {})["multiplier"] = mult

    elif tool_name == "set_exit_period":
        side = tool_input["side"]
        period = max(2, min(200, int(tool_input["period"])))
        ir.setdefault("exit_conditions", {}).setdefault(side, {})["period"] = period

    elif tool_name == "set_risk_per_trade":
        risk = max(0.1, min(5.0, float(tool_input["risk_pct"])))
        ir.setdefault("position_sizing", {})["risk_per_trade_pct"] = risk

    else:
        logger.warning("Unknown tool call: %s", tool_name)

    return ir


# ---------------------------------------------------------------------------
# Degenerate output detection
# ---------------------------------------------------------------------------

def build_extra_context(
    trade_count: int,
    prev_trade_count: int,
    sharpe: float,
    prev_sharpe: float,
) -> str:
    """Return a warning string injected into Claude's next message when results are degenerate."""
    if trade_count == 0:
        return (
            "\n\nWARNING: The strategy generated 0 trades in this backtest. "
            "The entry conditions are too restrictive. "
            "You MUST loosen at least one threshold value or reduce a period to allow trades to fire."
        )
    if prev_trade_count > 0 and trade_count == prev_trade_count and abs(sharpe - prev_sharpe) < 0.01:
        return (
            "\n\nWARNING: These results are essentially identical to the previous iteration. "
            "Your changes had no measurable effect. "
            "Please make a larger or different adjustment — try a different parameter."
        )
    return ""


# ---------------------------------------------------------------------------
# System prompt builder
# ---------------------------------------------------------------------------

def _build_system_prompt(user_system_prompt: str) -> str:
    base = (
        "You are an expert algorithmic forex trading strategy optimizer.\n"
        "Your job is to iteratively improve a trading strategy by analysing backtest results "
        "and calling the available tools to adjust strategy parameters.\n\n"
        "## Rules\n"
        "- Call one or more tools per response to adjust parameters.\n"
        "- ALWAYS explain your reasoning before calling tools: what the results tell you "
        "  and why the specific change should improve performance.\n"
        "- Focus on meaningful changes — small incremental adjustments to the weakest metric.\n"
        "- Do not try to adjust parameters that do not exist in the current strategy.\n"
        "- If win rate is the problem, adjust entry thresholds or periods.\n"
        "- If drawdown is the problem, tighten the stop_loss multiplier.\n"
        "- If profit factor is low, widen the take_profit multiplier relative to stop_loss.\n\n"
        "## Strategy IR entry_conditions reference\n"
        "Each entry condition in the array has an index starting at 0.\n"
        "Use that index when calling set_period, set_threshold, or set_operator.\n"
    )
    if user_system_prompt.strip():
        base += f"\n## Optimization goal (from operator)\n{user_system_prompt.strip()}\n"
    return base


# ---------------------------------------------------------------------------
# Analyze and mutate — main entry point
# ---------------------------------------------------------------------------
MAX_RETRIES = 3


def analyze_and_mutate(
    current_ir: dict,
    metrics: dict,
    trades_summary: list[dict],
    iteration_history: list[dict],
    user_system_prompt: str,
    user_prompt: str,
    conversation: list[dict],
    extra_context: str = "",
) -> tuple[dict, str, str]:
    """
    Call Claude synchronously with the current backtest results.
    Claude responds by calling mutation tools; we apply them to the IR.

    Returns:
        (updated_ir, ai_analysis_text, ai_changes_summary)

    Falls back to current_ir (unchanged) if all retries fail Pydantic validation.
    """
    # Build the analysis message content
    conditions_desc = "\n".join(
        f"  [{i}] indicator={c.get('indicator')} period={c.get('period')} "
        f"op={c.get('operator')} value={c.get('value')}"
        for i, c in enumerate(current_ir.get("entry_conditions", []))
    )
    exits = current_ir.get("exit_conditions", {})
    sl = exits.get("stop_loss", {})
    tp = exits.get("take_profit", {})

    trades_text = ""
    if trades_summary:
        sample = trades_summary[:10]
        trades_text = "\nSample trades (first 10):\n" + "\n".join(
            f"  {t.get('direction','?')} entry={t.get('entry_price')} "
            f"exit={t.get('exit_price')} pnl={t.get('pnl')}"
            for t in sample
        )

    history_text = ""
    if iteration_history:
        history_text = "\nIteration history:\n" + "\n".join(
            f"  Iter {h['iteration']}: Sharpe={h['sharpe']} WinRate={h['win_rate']} "
            f"Changes: {h['ai_changes']}"
            for h in iteration_history[-5:]  # last 5 only
        )

    analysis_request = (
        f"## Current strategy entry conditions\n{conditions_desc}\n\n"
        f"Stop loss: type={sl.get('type')} period={sl.get('period')} multiplier={sl.get('multiplier')}\n"
        f"Take profit: type={tp.get('type')} period={tp.get('period')} multiplier={tp.get('multiplier')}\n\n"
        f"## Latest backtest results\n"
        f"Sharpe ratio:  {metrics.get('sharpe')}\n"
        f"Win rate:      {metrics.get('win_rate')}\n"
        f"Max drawdown:  {metrics.get('max_dd')}\n"
        f"Trade count:   {metrics.get('trade_count')}\n"
        f"Total P&L:     {metrics.get('total_pnl')}\n"
        f"{trades_text}"
        f"{history_text}"
        f"{extra_context}\n\n"
        f"Analyse these results and call the appropriate tools to improve the strategy."
    )

    if user_prompt.strip():
        analysis_request += f"\n\nAdditional instruction: {user_prompt.strip()}"

    # Build message list: prior conversation (last 10 turns for context) + new message
    messages: list[dict] = list(conversation[-10:]) + [
        {"role": "user", "content": analysis_request}
    ]

    for attempt in range(MAX_RETRIES):
        try:
            response = _get_client().messages.create(
                model="claude-opus-4-6",
                max_tokens=1024,
                system=_build_system_prompt(user_system_prompt),
                messages=messages,  # type: ignore[arg-type]
                tools=OPTIMIZATION_TOOLS,  # type: ignore[arg-type]
            )
        except Exception as exc:
            logger.error("Claude API error on attempt %d: %s", attempt + 1, exc)
            if attempt == MAX_RETRIES - 1:
                return current_ir, f"Claude API error: {exc}", "no changes"
            continue

        # Extract text and tool calls from response
        text_parts = [b.text for b in response.content if b.type == "text"]
        tool_calls = [b for b in response.content if b.type == "tool_use"]
        ai_analysis = "\n".join(text_parts).strip()

        if not tool_calls:
            logger.info("Claude made no tool calls on attempt %d", attempt + 1)
            # Still valid — no changes this iteration
            return current_ir, ai_analysis, "no changes"

        # Apply all tool calls sequentially
        candidate_ir = current_ir
        change_descriptions: list[str] = []
        for tc in tool_calls:
            candidate_ir = apply_tool_call(candidate_ir, tc.name, tc.input)  # type: ignore[arg-type]
            change_descriptions.append(f"{tc.name}({tc.input})")
        ai_changes = "; ".join(change_descriptions)

        # Validate with Pydantic (Layer 2)
        try:
            StrategyIR.model_validate(candidate_ir)
            logger.info("Iteration IR valid after %d attempt(s). Changes: %s", attempt + 1, ai_changes)
            return candidate_ir, ai_analysis, ai_changes
        except Exception as validation_exc:
            logger.warning(
                "IR invalid on attempt %d/%d: %s", attempt + 1, MAX_RETRIES, validation_exc
            )
            if attempt < MAX_RETRIES - 1:
                # The Anthropic API requires every tool_use block to be immediately
                # followed by a user message containing tool_result blocks — a plain
                # text message is rejected with a 400. Supply proper tool_result blocks
                # with the error so Claude knows what went wrong.
                tool_results = [
                    {
                        "type": "tool_result",
                        "tool_use_id": tc.id,
                        "is_error": True,
                        "content": (
                            f"The tool was applied but the resulting strategy failed "
                            f"validation: {validation_exc}. Please revise your parameters."
                        ),
                    }
                    for tc in tool_calls
                ]
                messages.append({"role": "assistant", "content": response.content})
                messages.append({"role": "user", "content": tool_results})
            else:
                logger.error(
                    "All %d retry attempts failed validation. Keeping prior IR.", MAX_RETRIES
                )
                return (
                    current_ir,
                    ai_analysis,
                    f"VALIDATION FAILED after {MAX_RETRIES} retries — kept prior IR. "
                    f"Attempted: {ai_changes}",
                )

    # Should never reach here
    return current_ir, "", "no changes"
