# Optimization Tab — Implementation Plan

**Created:** 2026-04-12
**Status:** Planning

---

## Table of Contents

1. [Overview](#1-overview)
2. [Architecture decisions](#2-architecture-decisions)
3. [Step 1 — Database migrations](#3-step-1--database-migrations)
4. [Step 2 — AI optimization agent](#4-step-2--ai-optimization-agent)
5. [Step 3 — Optimization Celery task](#5-step-3--optimization-celery-task)
6. [Step 4 — Backend router](#6-step-4--backend-router)
7. [Step 5 — Frontend page](#7-step-5--frontend-page)
8. [Step 6 — Sidebar update](#8-step-6--sidebar-update)
9. [Step 7 — Tests](#9-step-7--tests)
10. [Step 8 — Implementation order](#10-step-8--implementation-order)
11. [Risk mitigations](#11-risk-mitigations)

---

## 1. Overview

The Optimization tab is an AI-driven iterative loop: the user configures a strategy,
pair, timeframe, and stopping conditions; the system iterates
**backtest → AI analysis → IR mutation → backtest** until a stopping condition is met.
Progress streams live to the UI via SSE.

**Two entry points:**
- **Generate new** — AI proposes a starting strategy from the RAG memory of prior tested strategies.
- **Refine existing** — User selects a saved strategy; AI iterates from that baseline.

**Stopping conditions (any one triggers completion):**
- Maximum number of iterations reached (default: 20)
- Elapsed time limit reached (default: 600 minutes / 10 hours)
- Target win rate achieved (e.g. ≥ 60%)
- Target Sharpe ratio achieved

**Final output:**
- Best iteration's strategy IR saved to the strategies library
- All iteration backtest runs accessible in the Backtest tab
- Full conversation log + metrics history on the Optimization run detail page

---

## 2. Architecture decisions

| Decision | Choice | Reason |
|---|---|---|
| Loop execution | Single long-running Celery task on a dedicated `optimization` queue | Backtest engine is sync; no sub-task fan-out needed; dedicated queue prevents blocking regular backtests |
| IR mutation | **Claude tool use API** (structured function calls) — not free-form `sir` block generation | Eliminates hallucinated fields; Anthropic API enforces tool input schemas |
| Validation fallback | Pydantic `StrategyIR` validation with up to 3 retries + error feedback to Claude | Catches any schema violation that tool-use alone misses |
| Progress delivery | Redis pub/sub → SSE (`text/event-stream`) on `GET /api/optimization/runs/{id}/stream` | Same pattern as Copilot streaming; no WebSocket state |
| Stop signal | Redis key `opt:stop:{run_id}` checked at top of each loop iteration | Clean cooperative shutdown; no SIGKILL needed |
| Candle chart | Reuse `GET /api/analytics/backtest/{id}/candles` from the best iteration's backtest run | Already implemented |
| Strategy persistence | Best iteration's IR saved as new strategy version in `strategies` table on completion | Immediately available in Strategies page and Backtest tab |

---

## 3. Step 1 — Database migrations

### `db/migrations/011_optimization_runs.sql`

```sql
CREATE TABLE optimization_runs (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID REFERENCES users(id),
    pair                VARCHAR(10)  NOT NULL,
    timeframe           VARCHAR(10)  NOT NULL,
    period_start        DATE         NOT NULL,
    period_end          DATE         NOT NULL,
    initial_strategy_id UUID         REFERENCES strategies(id),
    system_prompt       TEXT         NOT NULL DEFAULT '',
    user_prompt         TEXT         NOT NULL DEFAULT '',
    -- stopping conditions
    max_iterations      INTEGER      NOT NULL DEFAULT 20,
    time_limit_minutes  INTEGER      NOT NULL DEFAULT 600,
    target_win_rate     NUMERIC(6,4),          -- e.g. 0.6000 = 60%
    target_sharpe       NUMERIC(8,4),
    -- runtime state
    status              VARCHAR(20)  NOT NULL DEFAULT 'pending',
    --   pending | running | completed | stopped | failed
    current_iteration   INTEGER      NOT NULL DEFAULT 0,
    celery_task_id      TEXT,
    -- best result pointers (updated after each iteration)
    best_iteration      INTEGER,
    best_backtest_id    UUID         REFERENCES backtest_runs(id),
    best_strategy_id    UUID         REFERENCES strategies(id),
    best_sharpe         NUMERIC(8,4),
    best_win_rate       NUMERIC(6,4),
    -- timestamps
    created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    started_at          TIMESTAMPTZ,
    completed_at        TIMESTAMPTZ
);

CREATE INDEX idx_opt_runs_user ON optimization_runs(user_id, created_at DESC);
```

### `db/migrations/012_optimization_iterations.sql`

```sql
CREATE TABLE optimization_iterations (
    id               UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id           UUID    NOT NULL REFERENCES optimization_runs(id) ON DELETE CASCADE,
    iteration_number INTEGER NOT NULL,
    strategy_ir      JSONB   NOT NULL,
    backtest_run_id  UUID    REFERENCES backtest_runs(id),
    -- metrics (denormalised from backtest_runs for quick table render)
    sharpe           NUMERIC(8,4),
    win_rate         NUMERIC(6,4),
    max_dd           NUMERIC(8,4),
    total_pnl        NUMERIC(14,4),
    trade_count      INTEGER,
    -- AI output for this iteration
    ai_analysis      TEXT,   -- Claude's plain-English interpretation of results
    ai_changes       TEXT,   -- Claude's summary of what it changed and why
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_opt_iter_run ON optimization_iterations(run_id, iteration_number);
```

---

## 4. Step 2 — AI optimization agent

**New file: `backend/ai/optimization_agent.py`**

Separate from `claude_client.py`. Called synchronously from the Celery worker.

### 4.1 Tool use — the primary safety layer

Instead of asking Claude to produce a full IR in a `sir` code block, the agent
exposes a small set of named mutation tools. Claude can only call these tools;
it cannot touch the IR structure directly. The Anthropic API enforces the input
schema of each tool, making hallucinated fields structurally impossible.

```python
OPTIMIZATION_TOOLS = [
    {
        "name": "set_period",
        "description": "Change an indicator's lookback period.",
        "input_schema": {
            "type": "object",
            "properties": {
                "condition_index": {
                    "type": "integer",
                    "description": "Zero-based index into entry_conditions array."
                },
                "period": {"type": "integer", "minimum": 2, "maximum": 500}
            },
            "required": ["condition_index", "period"]
        }
    },
    {
        "name": "set_threshold",
        "description": "Change the numeric comparison value in an entry condition.",
        "input_schema": {
            "type": "object",
            "properties": {
                "condition_index": {"type": "integer"},
                "value": {"type": "number"}
            },
            "required": ["condition_index", "value"]
        }
    },
    {
        "name": "set_operator",
        "description": "Change the comparison operator in an entry condition.",
        "input_schema": {
            "type": "object",
            "properties": {
                "condition_index": {"type": "integer"},
                "operator": {
                    "type": "string",
                    "enum": [">", "<", ">=", "<=", "==",
                             "crossed_above", "crossed_below"]
                }
            },
            "required": ["condition_index", "operator"]
        }
    },
    {
        "name": "set_exit_multiplier",
        "description": "Change the ATR multiplier for stop_loss or take_profit.",
        "input_schema": {
            "type": "object",
            "properties": {
                "side": {"type": "string", "enum": ["stop_loss", "take_profit"]},
                "multiplier": {"type": "number", "minimum": 0.1, "maximum": 10.0}
            },
            "required": ["side", "multiplier"]
        }
    },
    {
        "name": "set_exit_period",
        "description": "Change the ATR period for stop_loss or take_profit.",
        "input_schema": {
            "type": "object",
            "properties": {
                "side": {"type": "string", "enum": ["stop_loss", "take_profit"]},
                "period": {"type": "integer", "minimum": 2, "maximum": 200}
            },
            "required": ["side", "period"]
        }
    },
    {
        "name": "set_risk_per_trade",
        "description": "Change the risk percentage per trade (position sizing).",
        "input_schema": {
            "type": "object",
            "properties": {
                "risk_pct": {"type": "number", "minimum": 0.1, "maximum": 10.0}
            },
            "required": ["risk_pct"]
        }
    }
]
```

### 4.2 Tool application

Each tool call from Claude is applied to the in-memory IR dict by a pure function:

```python
def apply_tool_call(ir: dict, tool_name: str, tool_input: dict) -> dict:
    """Apply a single Claude tool call to the IR. Returns modified copy."""
    ir = copy.deepcopy(ir)
    conditions = ir.get("entry_conditions", [])

    if tool_name == "set_period":
        idx = tool_input["condition_index"]
        if 0 <= idx < len(conditions):
            # Clamp defensively even though tool schema enforces range
            conditions[idx]["period"] = max(2, min(500, tool_input["period"]))

    elif tool_name == "set_threshold":
        idx = tool_input["condition_index"]
        if 0 <= idx < len(conditions):
            conditions[idx]["value"] = tool_input["value"]

    elif tool_name == "set_operator":
        idx = tool_input["condition_index"]
        if 0 <= idx < len(conditions):
            conditions[idx]["operator"] = tool_input["operator"]

    elif tool_name == "set_exit_multiplier":
        side = tool_input["side"]
        mult = max(0.1, min(10.0, tool_input["multiplier"]))
        ir.setdefault("exit_conditions", {}).setdefault(side, {})["multiplier"] = mult

    elif tool_name == "set_exit_period":
        side = tool_input["side"]
        p = max(2, min(200, tool_input["period"]))
        ir.setdefault("exit_conditions", {}).setdefault(side, {})["period"] = p

    elif tool_name == "set_risk_per_trade":
        ir.setdefault("position_sizing", {})["risk_per_trade_pct"] = \
            max(0.1, min(10.0, tool_input["risk_pct"]))

    return ir
```

### 4.3 Pydantic validation with retry + error feedback

After applying all tool calls, validate the result. If validation fails, send
Claude the exact error and ask it to correct. Up to 3 retries before falling
back to the prior IR:

```python
MAX_RETRIES = 3

def analyze_and_mutate(
    current_ir: dict,
    metrics: dict,
    trades_summary: list,
    iteration_history: list,
    user_system_prompt: str,
    user_prompt: str,
    conversation: list,
    extra_context: str = "",
) -> tuple[dict, str, str]:
    """
    Returns: (updated_ir, ai_analysis_text, ai_changes_summary)
    Falls back to current_ir if all retries fail validation.
    """
    messages = _build_messages(
        current_ir, metrics, trades_summary,
        iteration_history, user_prompt, conversation, extra_context
    )

    for attempt in range(MAX_RETRIES):
        response = anthropic_client.messages.create(
            model="claude-opus-4-6",
            system=_build_system_prompt(user_system_prompt),
            messages=messages,
            tools=OPTIMIZATION_TOOLS,
            max_tokens=1024,
        )

        tool_calls = [
            b for b in response.content
            if b.type == "tool_use"
        ]
        text_blocks = [
            b.text for b in response.content
            if b.type == "text"
        ]
        ai_analysis = "\n".join(text_blocks)

        # Apply all tool calls sequentially
        candidate_ir = current_ir
        changes = []
        for tc in tool_calls:
            candidate_ir = apply_tool_call(candidate_ir, tc.name, tc.input)
            changes.append(f"{tc.name}({tc.input})")
        ai_changes = "; ".join(changes) if changes else "no changes"

        # Validate with Pydantic
        try:
            StrategyIR(**candidate_ir)
            return candidate_ir, ai_analysis, ai_changes
        except ValidationError as exc:
            logger.warning(
                "Iteration IR invalid (attempt %d/%d): %s", attempt + 1, MAX_RETRIES, exc
            )
            if attempt < MAX_RETRIES - 1:
                # Feed error back to Claude for self-correction
                messages.append({"role": "assistant", "content": response.content})
                messages.append({
                    "role": "user",
                    "content": (
                        f"Your proposed changes produced an invalid strategy: {exc}. "
                        f"Please correct the tool calls."
                    )
                })
            else:
                logger.error("All retries failed. Keeping prior IR for this iteration.")
                return current_ir, ai_analysis, f"VALIDATION FAILED after {MAX_RETRIES} retries. {ai_changes}"

    return current_ir, "", "no changes"  # unreachable but satisfies type checker
```

### 4.4 Degenerate output detection

After each backtest, check for degenerate results before calling the AI.
The `extra_context` string is injected into the next Claude message:

```python
def build_extra_context(trade_count: int, prev_trade_count: int,
                        sharpe: float, prev_sharpe: float) -> str:
    if trade_count == 0:
        return (
            "WARNING: The strategy generated 0 trades. "
            "Entry conditions are too restrictive. "
            "You MUST loosen at least one threshold value or reduce a period."
        )
    if trade_count == prev_trade_count and abs(sharpe - prev_sharpe) < 0.01:
        return (
            "WARNING: Results are identical to the previous iteration. "
            "Your changes had no measurable effect. "
            "Please make a larger or different adjustment."
        )
    return ""
```

---

## 5. Step 3 — Optimization Celery task

**New file: `backend/tasks/optimization.py`**

Runs on the dedicated `optimization` Celery queue to avoid blocking regular backtests.

```
@celery_app.task(bind=True, name="tasks.optimization.run",
                 queue="optimization",
                 task_time_limit=time_limit_minutes * 60 + 300)  # safety net above in-loop check
def run_optimization_task(self, run_id: str) -> dict:
```

### Loop pseudocode

```
started_at = now()
current_ir  = load_initial_ir(run)
prev_trade_count = 0
prev_sharpe = 0.0
conversation = []

while True:
    # 1. Check stop signal (cooperative shutdown)
    if redis.get(f"opt:stop:{run_id}"):
        mark_run(status="stopped")
        break

    # 2. Check time limit
    if elapsed_minutes(started_at) >= run.time_limit_minutes:
        mark_run(status="completed", reason="time_limit")
        break

    # 3. Check iteration limit
    if run.current_iteration >= run.max_iterations:
        mark_run(status="completed", reason="max_iterations")
        break

    # 4. Run backtest inline (sync engine call — no sub-task)
    result = run_backtest(ir=current_ir, pair=run.pair, ...)
    store_backtest_run_and_trades(result)

    metrics = extract_metrics(result)
    trade_count = metrics["trade_count"]
    sharpe = metrics["sharpe"] or 0.0

    # 5. Store iteration row
    store_optimization_iteration(run_id, iteration_number, current_ir, metrics)

    # 6. Update best if improved
    if sharpe > run.best_sharpe:
        update_run_best(run_id, sharpe, win_rate, backtest_run_id)

    # 7. Check performance stopping conditions
    if run.target_win_rate and metrics["win_rate"] >= run.target_win_rate:
        mark_run(status="completed", reason="target_win_rate")
        break
    if run.target_sharpe and sharpe >= run.target_sharpe:
        mark_run(status="completed", reason="target_sharpe")
        break

    # 8. Build degenerate context
    extra_context = build_extra_context(trade_count, prev_trade_count, sharpe, prev_sharpe)

    # 9. AI analysis + mutation (tool use — see Step 2)
    new_ir, ai_analysis, ai_changes = analyze_and_mutate(
        current_ir=current_ir,
        metrics=metrics,
        trades_summary=result.trades[:20],
        iteration_history=load_iteration_history(run_id),
        user_system_prompt=run.system_prompt,
        user_prompt=run.user_prompt,
        conversation=conversation,
        extra_context=extra_context,
    )

    # 10. Update iteration row with AI output
    update_iteration_ai_output(iteration_id, ai_analysis, ai_changes)

    # 11. Publish SSE progress event
    publish_opt_event(run_id, {
        "event":       "iteration",
        "iteration":   run.current_iteration + 1,
        "sharpe":      sharpe,
        "win_rate":    metrics["win_rate"],
        "max_dd":      metrics["max_dd"],
        "trade_count": trade_count,
        "best_sharpe": run.best_sharpe,
        "ai_analysis": ai_analysis,
        "ai_changes":  ai_changes,
    })

    # 12. Advance
    current_ir = new_ir
    prev_trade_count = trade_count
    prev_sharpe = sharpe
    increment_iteration(run_id)

# On exit: save best IR as new strategy version
save_best_strategy(run_id)
publish_opt_event(run_id, {"event": "completed", "run_id": run_id})
```

### SSE event shapes

```json
// Each iteration
{ "event": "iteration", "iteration": 3, "sharpe": 1.24, "win_rate": 0.57,
  "max_dd": -0.09, "trade_count": 142, "best_sharpe": 1.31,
  "ai_analysis": "RSI period was too short...",
  "ai_changes": "set_period({condition_index:0, period:18})" }

// Terminal events
{ "event": "completed", "reason": "target_win_rate", "run_id": "..." }
{ "event": "stopped",   "run_id": "..." }
{ "event": "failed",    "error": "...", "run_id": "..." }
```

---

## 6. Step 4 — Backend router

**New file: `backend/routers/optimization.py`**

| Endpoint | Method | Description |
|---|---|---|
| `/api/optimization/runs` | GET | List user's runs (latest 20), newest first |
| `/api/optimization/runs` | POST | Create run + dispatch Celery task, return `{run_id}` |
| `/api/optimization/runs/{id}` | GET | Full run detail + all iterations |
| `/api/optimization/runs/{id}/stop` | POST | Set `opt:stop:{id}` Redis key; task exits at next check |
| `/api/optimization/runs/{id}/stream` | GET | SSE — subscribe to Redis `opt:{id}` channel |

### `POST /api/optimization/runs` request body

```json
{
  "pair":                "EURUSD",
  "timeframe":           "1H",
  "period_start":        "2023-01-01",
  "period_end":          "2024-12-31",
  "initial_strategy_id": "uuid-or-null",
  "system_prompt":       "Maximize Sharpe ratio. Keep max drawdown below 15%.",
  "user_prompt":         "Focus on RSI thresholds and ATR stop multiplier.",
  "max_iterations":      20,
  "time_limit_minutes":  600,
  "target_win_rate":     0.60,
  "target_sharpe":       null
}
```

Register in `backend/main.py` alongside existing routers.

---

## 7. Step 5 — Frontend page

**New file: `frontend/src/app/optimization/page.tsx`**

### Layout

```
┌── Left panel (320px, shrink-0) ─────────────────────────────┐
│ Strategy Source                                              │
│   ○ Generate new   ● Refine existing  [Strategy dropdown]   │
│                                                              │
│ Backtest Window                                              │
│   Pair [EURUSD▾]  Timeframe [1H▾]                          │
│   From [2023-01-01]   To [2024-12-31]                       │
│                                                              │
│ AI Instructions                                              │
│   System prompt (optimization goal):                         │
│   [textarea — "Maximize Sharpe, DD < 15%"]                  │
│   User prompt (parameter focus):                             │
│   [textarea — "Adjust RSI period and ATR multiplier"]        │
│                                                              │
│ Stopping Conditions                                          │
│   Max iterations: [20]                                       │
│   Time limit: [600] min                                      │
│   Target win rate: [60] %    Target Sharpe: [—]             │
│                                                              │
│ [▶ Start Optimization]          [■ Stop]                    │
│                                                              │
│ ── Status ──────────────────────────────────────────────── │
│ Running — Iteration 7 / 20                                  │
│ Best so far: Sharpe 1.31 · Win 57% · DD 8.2%               │
│                                                              │
│ (completed) [Save Strategy] [View in Backtest]              │
└──────────────────────────────────────────────────────────────┘

┌── Right panel (flex-1) ─────────────────────────────────────┐
│ [Candlestick chart — best iteration's backtest candles]     │
│ (reuses existing chart from backtest/results/[id]/page.tsx) │
├─────────────────────────────────────────────────────────────┤
│ AI Dialogue                                                  │
│ Iter 1 → "RSI period too short for 1H trend detection…"    │
│          Changed: set_period(0→18), set_exit_multiplier(SL→2.5) │
│ Iter 2 → "DD improved but win rate still below target…"     │
│          Changed: set_threshold(0→55.0)                     │
│ …                                                            │
├─────────────────────────────────────────────────────────────┤
│ Iteration History                                            │
│ # │ Sharpe │ Win%  │ Max DD │ Trades │  P&L   │ Changes    │
│ 1 │  0.82  │ 52.1% │ -11.2% │  134   │ +$2,140│ period …  │
│ 2 │  1.14  │ 55.3% │  -9.1% │  128   │ +$3,820│ threshold │
│ * │ best iteration highlighted in accent colour              │
└──────────────────────────────────────────────────────────────┘
```

### State machine

| State | Description |
|---|---|
| `idle` | Form visible and enabled; Start button active |
| `running` | SSE connected; progress updating; form locked; Stop button active |
| `completed` | Final results shown; "Save Strategy" + "View in Backtest" buttons appear |
| `stopped` | Same as completed but with "Stopped early" badge |
| `failed` | Error message shown; form re-enabled |

### SSE connection

```typescript
// Connect on run start
const es = new EventSource(`/api/optimization/runs/${runId}/stream`);

es.addEventListener("iteration", (e) => {
  const data = JSON.parse(e.data);
  appendIteration(data);       // adds row to table + dialogue entry
  updateBestMetrics(data);     // updates left panel status
  if (data.iteration === 1) loadChart(bestBacktestId);  // first candles
});

es.addEventListener("completed", () => { setStatus("completed"); es.close(); });
es.addEventListener("stopped",   () => { setStatus("stopped");   es.close(); });
es.addEventListener("failed",    (e) => { setError(e.data); es.close(); });
```

On reconnect (e.g. page refresh during a running optimization): fetch
`GET /api/optimization/runs/{id}` to restore state, then reconnect SSE.

---

## 8. Step 6 — Sidebar update

**File: `frontend/src/components/Sidebar.tsx`**

Add one entry between "AI Co-Pilot" and "Live Trading":

```typescript
const NAV_ITEMS = [
  { href: "/dashboard",    label: "Dashboard",    phase: null },
  { href: "/backtest",     label: "Backtest",     phase: 1 },
  { href: "/strategies",   label: "Strategies",   phase: 2 },
  { href: "/copilot",      label: "AI Co-Pilot",  phase: 2 },
  { href: "/optimization", label: "Optimization", phase: 3 },  // NEW
  { href: "/live",         label: "Live Trading", phase: 4 },
] as const;
```

---

## 9. Step 7 — Tests

**New file: `backend/tests/test_optimization.py`**

| Test | What it verifies |
|---|---|
| `test_create_run` | POST creates DB row, dispatches Celery task, returns `run_id` |
| `test_stop_run` | POST /stop sets Redis flag; task exits at next iteration check |
| `test_stopping_condition_iterations` | Loop exits when `current_iteration >= max_iterations` |
| `test_stopping_condition_win_rate` | Loop exits when `win_rate >= target_win_rate` |
| `test_stopping_condition_time` | Loop exits when elapsed time exceeds `time_limit_minutes` |
| `test_tool_application_set_period` | `apply_tool_call("set_period", {condition_index:0, period:18})` mutates IR correctly |
| `test_tool_application_clamps_out_of_range` | period=600 clamped to 500; multiplier=50 clamped to 10 |
| `test_tool_application_ignores_bad_index` | `condition_index=99` on a 2-condition IR → no change, no crash |
| `test_analyze_and_mutate_valid` | Claude response with valid tool calls → updated IR passes Pydantic |
| `test_analyze_and_mutate_retry_on_invalid` | Mocked Claude returns invalid tool call on attempt 1, valid on attempt 2 |
| `test_analyze_and_mutate_all_retries_fail` | All 3 attempts fail Pydantic → fallback to prior IR, no exception |
| `test_degenerate_zero_trades` | `build_extra_context(0, ...)` returns the zero-trades warning string |
| `test_degenerate_unchanged_results` | Identical metrics → returns the "no measurable effect" warning |
| `test_best_tracking` | After 3 iterations (Sharpe 0.8, 1.3, 1.1), `best_sharpe=1.3` and `best_iteration=2` |
| `test_save_best_strategy` | On completion, best IR is written to `strategies` table as a new row |

---

## 10. Step 8 — Implementation order

1. **Migrations 011 + 012** — apply via `psql` on staging manually (same as all prior migrations)
2. **`ai/optimization_agent.py`** — tool definitions, `apply_tool_call`, `analyze_and_mutate`, `build_extra_context` + unit tests
3. **`tasks/optimization.py`** — full loop, stopping conditions, progress publish, best tracking
4. **`routers/optimization.py`** — CRUD + SSE stream; register in `main.py`
5. **`frontend/src/app/optimization/page.tsx`** — full page (config panel, SSE handler, chart, dialogue, table)
6. **`frontend/src/components/Sidebar.tsx`** — add Optimization nav item
7. **CI + staging deploy**
8. **End-to-end smoke test**: start a 3-iteration run on EURUSD 1H (2023-01-01 → 2023-12-31), confirm all 3 iteration rows in DB, final strategy saved to strategies table, chart renders, crosshair syncs

---

## 11. Risk mitigations

### Claude produces invalid IR

Mitigated with **four layers** (see Step 2 for full detail):

| Layer | Mechanism | Catches |
|---|---|---|
| **1 — Tool use API** | Claude can only call named mutation tools; Anthropic API enforces JSON schema on inputs | Hallucinated fields, wrong field names, wrong IR structure |
| **2 — Pydantic + retry** | `StrategyIR(**ir)` validation after applying tool calls; up to 3 retries with error fed back to Claude | Out-of-range values, invalid operator/value combos |
| **3 — Value clamping** | `apply_tool_call` clamps all numeric values to valid bounds before applying | Minor boundary violations — produces runnable strategy instead of crash |
| **4 — Degenerate detection** | 0-trade and unchanged-result checks inject targeted warnings into next Claude message | Valid-but-useless mutations |

### Celery task timeout

Set `task_time_limit = time_limit_minutes * 60 + 300` as a hard Celery ceiling
above the in-loop time check. The in-loop check exits cleanly at `time_limit_minutes`;
the Celery limit is a safety net for any runaway scenario.

### Celery queue starvation

Optimization task runs on a dedicated `optimization` Celery queue. The existing
`default` queue handles regular backtests, Copilot tasks, etc. A long 10-hour
optimization run never delays a 10-second backtest.

### SSE drops during long run

On reconnect, the frontend re-fetches `GET /api/optimization/runs/{id}` to restore
current state (iteration count, best metrics, all prior iterations). It then
reconnects the SSE stream. The task continues running server-side regardless of
client disconnects.

### Backtest inner loop too slow

Each iteration calls the backtest engine inline (synchronous, no Celery sub-task).
For a 2-year 1H dataset (~17,000 bars) this is typically <2 seconds. If a future
requirement needs 1m data (>500k bars), consider batching or limiting period
during optimization and only running the full period on the final best strategy.
