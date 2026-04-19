# G-Optimize — Feature Spec

**Status:** Planned  
**Phase:** 3.6 (after Indicator Lab, before Phase 4 Live Trading)  
**Complexity:** High — new Celery pipeline, SIR extensions, RAG integration, multi-panel UI  
**Depends on:** Existing backtest engine, Celery/Redis infrastructure, Voyage AI RAG pipeline, Co-Pilot SSE

---

## Purpose

Automated global strategy discovery engine. Randomly samples thousands of strategy configurations
from a user-defined parameter space, backtests all of them, stores results, filters by user-defined
performance thresholds, and injects passing strategies into the RAG corpus so the Co-Pilot can
analyse and recommend the best candidates for live deployment.

This is NOT a replacement for the per-strategy Optimization tab. That tab refines a single known
strategy. G-Optimize discovers new strategies from scratch via random search across a wide
parameter space.

---

## Navigation

New sidebar item between Indicator Lab and Live:

```
Dashboard
Strategies
Backtest
Optimization
Co-Pilot
Superchart
Indicator Lab
→ G-Optimize     ← new
Live
ForEx News
Settings
```

Route: `/g-optimize`  
Outer wrapper: `<div className="flex h-full overflow-hidden -m-1">` (full-viewport, same as Strategies + Co-Pilot)

---

## UI Layout

Three horizontal sections stacked vertically:

```
┌─────────────────────────────────────────────────────────────────────────┐
│  TOP: Run Config (collapsible — hidden when a run is selected)          │
├──────────────────────────┬──────────────────────────────────────────────┤
│  LEFT: Runs panel (w-56) │  RIGHT: Strategies panel (flex-1)           │
│                          │                                              │
│  List of all G-Optimize  │  Strategies from selected/checked runs       │
│  runs with status badges │  Passed + Failed tabs with checkboxes        │
│                          │                                              │
├──────────────────────────┴──────────────────────────────────────────────┤
│  BOTTOM: Co-Pilot Analysis panel                                        │
│  Selection summary + scope selector + Send to Co-Pilot button          │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Run Config Panel

Shown when creating a new run. Collapses after submission. Divided into four blocks.

### Entry Conditions

Dynamic list — up to 10 conditions. Each row:

```
[Indicator ▾] [Param inputs] [Operator ▾] [Value/Threshold]  ×

Examples:
RSI    period range [5 ── 30]  step [5]     >              [value range 40──70]  ×
EMA    period range [8 ──200]  step [10]    crosses_above  EMA period [20──100]  ×
ADX    period range [10── 30]  step [5]     >              [value range 20──30]  ×
MACD   fast [8──16] slow [20──32] signal [7──12]  >        [0]                   ×
BB     period [10──30] std_dev [1.5──3.0]   price_above    upper                 ×
ATR    period range [10── 20]               >              [value range]         ×
STOCH  k [5──14] d [3──5]                  crosses_above  [value range 20──50]  ×
SMA    period range [20──200]  step [20]    price_above                          ×

[+ Add Condition]   (disabled when 10 reached)
```

**Conditions per strategy:** user sets max (1–10). The sampler draws a random number between
1 and max for each configuration, then randomly selects that many conditions from the enabled
indicator set.

Supported operators: `>`, `<`, `crosses_above`, `crosses_below`, `price_above`, `price_below`

Supported indicators: RSI, EMA, SMA, MACD, BB, ATR, ADX, STOCH (all 8 existing engine indicators)

### Exit Conditions

Mirror of Entry Conditions — same indicator builder, exit-specific operators
(`crosses_below`, `<`, `price_below`), plus three dedicated stop types.

**Exit mode** (controls how indicator exits interact with SL/TP):

```
Exit mode:
  ● First to trigger     — any condition closes the trade (most common)
  ○ All must be true     — indicator exits AND SL/TP both required simultaneously
  ○ SL/TP only           — ignore indicator exits entirely, use stops only
```

Stored as `exit_mode: "first" | "all" | "stops_only"` in the SIR extension.
The G-Optimize sampler includes exit mode in the random draw.

**Stop Loss:**
```
  ● ATR-based    period [14]  multiplier range [1.0 ── 3.0]  step [0.5]
  ○ Fixed pips   range [10 ──── 50]
```

**Take Profit:**
```
  ● ATR-based    period [14]  multiplier range [1.5 ── 5.0]  step [0.5]
  ○ Fixed pips   range [20 ──── 100]
```

**Trailing Stop:**
```
  [✓] Enabled
  ● ATR-based    period [14]  multiplier range [1.0 ── 2.0]
  ○ Fixed pips   range [10 ──── 30]
  Activation: after [1.0 ── 2.0] × ATR in profit
```

**R:R floor:** TP must be ≥ N × SL. Configurations violating this are discarded before
backtesting. Default: 1.5.

### Search Config

```
Pairs:      [✓]EURUSD [✓]GBPUSD [✓]USDJPY [✓]EURGBP [✓]GBPJPY [✓]USDCHF
Timeframe:  1H (fixed)
Period:     [2022-01-01] → [2025-01-01]
Configurations to sample:  [5000]

Store trades:
  ● Passing strategies only   ○ All   ○ None

  ⓘ "Passing only" stores individual trades for threshold-passing strategies,
     enabling Trade Analysis on results. "All" adds ~3M rows per 5,000 config run.
```

### Passing Threshold

```
Sharpe ≥    [0.8]
Win Rate ≥  [45] %
Max DD ≤    [15] %
Min trades: [30]

On pass:  ● Auto-send to RAG   ○ Review first
```

Auto-send embeds the strategy immediately via Voyage AI → pgvector on passing.
Review-first holds strategies in a Pending state in the Passed tab; user clicks
[Promote to RAG] per row.

**Estimated run time** is shown below the Start button:
```
Estimated: ~2.4 hrs   (based on avg 1.7s/backtest × 5,000 × 6 pairs)
[▶ Start G-Optimize]
```

---

## Runs Panel (left, w-56)

Lists all G-Optimize runs, newest first:

```
[□] Run #3  Apr 19              ← checkbox for multi-run selection
    EURUSD + GBPUSD · 1H
    5,000 configs
    47 passed  ● Done

[□] Run #2  Apr 18
    ALL pairs · 1H
    10,000 configs
    103 passed  ● Done

[□] Run #1  Apr 17
    USDJPY · 1H
    2,000 configs
    12 passed  ● Done

[+ New Run]
```

**Status badges:**

| Badge | Meaning |
|---|---|
| `● Running` | In progress — progress bar + % shown below |
| `● Done` | Completed — results available |
| `○ Stopped` | User cancelled — partial results available |
| `○ Failed` | Task error — error message on hover |

Clicking a run highlights it and loads its strategies into the Strategies panel.
Checking the checkbox (without clicking the row) adds its strategies to a multi-run
merged view without changing the highlighted run.

---

## Strategies Panel (right, flex-1)

Shows strategies from the highlighted run (or merged across checked runs).

**Tabs:** `[Passed ✓  47]` `[Failed ✗  4,953]`

### Passed tab

```
── Run #3  Apr 19 ───────────────────────────────────────────────────
[✓] EURUSD │ RSI(14)>50 + EMA cross  │ Sharpe 1.42 │ WR 53% │ DD 8%  │ In RAG  [▸]
[✓] GBPUSD │ ADX(25) + MACD hist     │ Sharpe 1.38 │ WR 51% │ DD 9%  │ In RAG  [▸]
[□] EURUSD │ RSI(14) + BB upper      │ Sharpe 1.21 │ WR 49% │ DD 11% │ Pending [▸]

── Run #1  Apr 17 ───────────────────────────────────────────────────
[✓] USDJPY │ EMA(20) cross + ADX     │ Sharpe 1.31 │ WR 54% │ DD 6%  │ In RAG  [▸]
[□] USDJPY │ RSI(10) + STOCH cross   │ Sharpe 0.98 │ WR 47% │ DD 13% │ Pending [▸]

[Select All] [Clear]   Sort: [Sharpe ▾]
```

Run section headers only appear when multiple runs are checked. Single-run view shows
a flat list.

**Status column:**

| Value | Meaning |
|---|---|
| `In RAG` | Embedded in pgvector — Co-Pilot can retrieve it |
| `Pending` | Passed threshold but not yet embedded (review-first mode) |
| `Promoting...` | Voyage AI embed in progress |

`[▸]` expands an inline detail row showing full IR (human-readable via `conditionToLabel`),
all metrics, and an `[Open in Co-Pilot →]` button.

### Failed tab

Same table structure, no RAG/Promote column. Sorted by Sharpe descending so near-misses
float to the top. Near-miss strategies (within 10% of any threshold) get a subtle yellow
left border — visible at a glance without filtering.

A `[Promote to RAG]` button appears per row — allows manual promotion of any failed strategy
without re-running the backtest. Writes `passed_threshold = TRUE` and triggers embedding.

---

## Co-Pilot Analysis Panel (bottom)

Appears below the Strategies panel. Always visible.

```
┌─── Co-Pilot Analysis ──────────────────────────────────────────────────┐
│  Selected:  2 runs  ·  7 strategies                                   │
│                                                                        │
│  Scope:                                                                │
│    ● Checked strategies only                                           │
│    ○ All passed from checked runs                                      │
│    ○ All passed from all runs                                          │
│                                                                        │
│  [✦ Send to Co-Pilot for Analysis]                                     │
│                                                                        │
│  ── After analysis ─────────────────────────────────────────────────  │
│                                                                        │
│  Co-Pilot recommends:                                                  │
│                                                                        │
│  ★ #1  RSI(14)>50 + EMA(20) cross  │ EURUSD │ Sharpe 1.42            │
│      "Strongest edge. 187 trades gives statistical confidence.         │
│       Appeared in Run #3 and Run #1 with consistent Sharpe —          │
│       cross-run robustness signal. Suggest tightening RSI to 55."     │
│      [Open in Co-Pilot →]                                              │
│                                                                        │
│  ★ #2  ADX(14)>25 + MACD hist  │ GBPUSD  │ Sharpe 1.38              │
│      "ADX filter adds robustness on trending pairs. Consider           │
│       testing on EURUSD — similar market structure."                   │
│      [Open in Co-Pilot →]                                              │
│                                                                        │
│  ⚠ Skipped 2 strategies with < 50 trades (low confidence)             │
│                                                                        │
└────────────────────────────────────────────────────────────────────────┘
```

### Scope options

| Scope | What Co-Pilot receives |
|---|---|
| **Checked strategies only** | Exact rows ticked in the Strategies panel — can span multiple runs |
| **All passed from checked runs** | Every passing strategy from checked runs — ignores individual strategy checkboxes |
| **All passed from all runs** | Full G-Optimize RAG corpus regardless of run |

### What Claude evaluates when ranking

| Factor | Weight |
|---|---|
| Sharpe ratio | Primary ranking signal |
| Trade count | Statistical confidence — penalises low-sample strategies |
| Max drawdown | Survivability in live conditions |
| Cross-run consistency | Same indicator combo appearing in multiple runs = robustness signal |
| Diversity from #1 | Avoids recommending two near-identical strategies |
| Exit mode | `all must be true` tends to be more conservative — noted in output |

### Technical implementation

This call uses `get_full_response()` via `model_router.py` (not SSE streaming) — result is a
structured ranking rendered when complete. Respects the user's selected AI model from Settings.
The prompt is built in `backend/ai/g_optimize_agent.py`.

### Path to Live

After Co-Pilot analysis, the user opens a recommended strategy in Co-Pilot via
`[Open in Co-Pilot →]`. Co-Pilot refines the strategy through the normal chat flow.
Deployment to live trading happens through the existing Live Trading path — no direct
"Send to Live" shortcut from G-Optimize. Every strategy must go through Co-Pilot
refinement before deployment.

---

## SIR Extensions

Two new fields added to the SIR schema. Existing strategies with these fields absent
fall back to current behaviour (no trailing stop, `stops_only` exit mode).

### `exit_mode`

```json
{
  "exit_conditions": {
    "exit_mode": "first",
    "indicator_exits": [
      { "indicator": "RSI", "period": 14, "operator": ">", "value": 70 }
    ],
    "stop_loss":   { "type": "atr", "period": 14, "multiplier": 1.5 },
    "take_profit": { "type": "atr", "period": 14, "multiplier": 3.0 }
  }
}
```

### `trailing_stop`

```json
{
  "exit_conditions": {
    "trailing_stop": {
      "enabled": true,
      "type": "atr",
      "period": 14,
      "multiplier": 1.5,
      "activation_multiplier": 1.0
    }
  }
}
```

`activation_multiplier` — trailing stop only activates after price moves
`activation_multiplier × ATR` in profit from entry. Before activation, the fixed SL applies.

`engine/parser.py` and `engine/runner.py` must handle both new fields.
This is a prerequisite for G-Optimize and should be built as Step 0.

---

## Database

### New table: `g_optimize_runs`

```sql
CREATE TABLE g_optimize_runs (
    id                  SERIAL PRIMARY KEY,
    user_id             INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status              VARCHAR(20) NOT NULL DEFAULT 'pending',
                        -- 'pending' | 'running' | 'done' | 'stopped' | 'failed'
    pairs               TEXT[]       NOT NULL,
    timeframe           VARCHAR(5)   NOT NULL DEFAULT '1H',
    period_start        DATE         NOT NULL,
    period_end          DATE         NOT NULL,
    n_configs           INTEGER      NOT NULL,
    store_trades        VARCHAR(10)  NOT NULL DEFAULT 'passing',
                        -- 'passing' | 'all' | 'none'
    entry_config        JSONB        NOT NULL,   -- indicator ranges + max conditions
    exit_config         JSONB        NOT NULL,   -- exit indicator ranges + SL/TP/trailing ranges
    threshold_sharpe    NUMERIC(5,2) NOT NULL,
    threshold_win_rate  NUMERIC(5,2) NOT NULL,
    threshold_max_dd    NUMERIC(5,2) NOT NULL,
    threshold_min_trades INTEGER     NOT NULL,
    auto_rag            BOOLEAN      NOT NULL DEFAULT TRUE,
    configs_total       INTEGER      NOT NULL DEFAULT 0,
    configs_done        INTEGER      NOT NULL DEFAULT 0,
    configs_passed      INTEGER      NOT NULL DEFAULT 0,
    configs_failed      INTEGER      NOT NULL DEFAULT 0,
    error_message       TEXT,
    started_at          TIMESTAMPTZ,
    completed_at        TIMESTAMPTZ,
    created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
```

### Migration: `backtest_runs` additions

```sql
ALTER TABLE backtest_runs
    ADD COLUMN source              VARCHAR(20) NOT NULL DEFAULT 'manual',
                                   -- 'manual' | 'optimization' | 'g_optimize'
    ADD COLUMN g_optimize_run_id   INTEGER REFERENCES g_optimize_runs(id) ON DELETE SET NULL,
    ADD COLUMN passed_threshold    BOOLEAN;
                                   -- NULL for manual/optimization; TRUE/FALSE for g_optimize

CREATE INDEX idx_backtest_runs_source ON backtest_runs(source);
CREATE INDEX idx_backtest_runs_g_optimize ON backtest_runs(g_optimize_run_id)
    WHERE g_optimize_run_id IS NOT NULL;
```

---

## API Endpoints

New file: `backend/routers/g_optimize.py`, prefix `/api/g-optimize`

| Endpoint | Purpose |
|---|---|
| `POST /api/g-optimize/runs` | Create + enqueue a new G-Optimize run |
| `GET /api/g-optimize/runs` | List all runs for current user (status, counts) |
| `GET /api/g-optimize/runs/{id}` | Run detail + progress counts |
| `GET /api/g-optimize/runs/{id}/stream` | SSE — live progress events during run |
| `POST /api/g-optimize/runs/{id}/stop` | Set Redis stop-signal key → graceful halt |
| `DELETE /api/g-optimize/runs/{id}` | Delete run + its backtest_runs rows (only if not running) |
| `GET /api/g-optimize/runs/{id}/strategies` | Paginated strategies for a run (passed/failed filter, sort) |
| `POST /api/g-optimize/strategies/{backtest_id}/promote` | Manually promote a failed strategy to RAG |
| `POST /api/g-optimize/analyze` | Co-Pilot ranking analysis — accepts list of backtest_run_ids |

SSE auth: `get_current_user_sse` (token via query param) — same pattern as optimization SSE.

---

## Backend Architecture

### New files

| File | Purpose |
|---|---|
| `backend/tasks/g_optimize.py` | Celery orchestrator task — sampler + sub-task dispatch + RAG inject |
| `backend/ai/g_optimize_agent.py` | Co-Pilot ranking prompt builder + response parser |
| `backend/routers/g_optimize.py` | API endpoints |

### New Celery queue

```python
# celery_app.py — add g_optimize queue
task_routes = {
    "tasks.g_optimize.*": {"queue": "g_optimize"},
    "tasks.backtest.*":   {"queue": "celery"},
    "tasks.optimization.*": {"queue": "optimization"},
}
```

Separate queue prevents G-Optimize from blocking interactive backtests.

### Orchestrator task — `tasks/g_optimize.py`

```python
@celery.task
def run_g_optimize(run_id: int):
    run = fetch_run(run_id)
    sampler = ConfigSampler(run.entry_config, run.exit_config)

    for i in range(run.n_configs):
        if redis.exists(f"g_optimize:stop:{run_id}"):
            update_status(run_id, "stopped")
            return

        sir = sampler.sample()           # random SIR from parameter space

        for pair in run.pairs:
            result = run_backtest(sir, pair, run.timeframe,
                                  run.period_start, run.period_end)

            passed = evaluate_threshold(result, run)

            store_backtest_run(result,
                source="g_optimize",
                g_optimize_run_id=run_id,
                passed_threshold=passed,
                store_trades=(passed or run.store_trades == "all")
                              and run.store_trades != "none")

            if passed and run.auto_rag:
                embed_and_inject_rag(result)   # Voyage AI → pgvector

            increment_progress(run_id, passed=passed)
            publish_progress(run_id, i, passed)   # Redis → SSE

    update_status(run_id, "done")
```

### Config sampler — `ConfigSampler`

Generates a random valid SIR from the parameter space defined in `entry_config` / `exit_config`.

```python
class ConfigSampler:
    def sample(self) -> dict:
        n_entry = random.randint(1, self.max_entry_conditions)
        indicators = random.sample(self.enabled_indicators, n_entry)
        entry_conditions = [self._sample_indicator(ind) for ind in indicators]

        exit_mode = random.choice(["first", "all", "stops_only"])
        sl = self._sample_sl()
        tp = self._sample_tp()

        # Enforce R:R floor
        while tp_multiplier < self.rr_floor * sl_multiplier:
            tp = self._sample_tp()

        trailing = self._sample_trailing() if self.trailing_enabled else None

        return build_sir(entry_conditions, exit_mode, sl, tp, trailing)
```

### RAG injection

Reuses existing Voyage AI embed pipeline. Passing strategies get:
- `source: "g_optimize"` tag in the description so Co-Pilot knows the provenance
- Full metrics in the embeddable text
- Strategy saved to `strategies` table with `name = "[G-Opt] {pair} {TF} {date}"` so it
  appears as a normal strategy for Co-Pilot refinement

```python
def embed_and_inject_rag(result):
    description = build_description(result)   # human-readable IR + metrics
    embedding = voyage_embed(description)
    insert_strategy(result.sir, description, source="g_optimize")
    insert_pgvector(strategy_id, embedding)
```

---

## Co-Pilot Integration

### `backend/ai/g_optimize_agent.py`

Builds the ranking prompt and parses the structured response.

```python
async def analyze_and_rank(strategies: list[dict], model: str) -> dict:
    prompt = build_ranking_prompt(strategies)
    response = await get_full_response(prompt, model=model)
    return parse_ranking_response(response)
```

**What Co-Pilot receives in the prompt:**

```
You have access to {N} machine-tested strategies from G-Optimize runs.

Your task:
1. Identify the 2–3 strongest candidates for live deployment consideration
2. Explain what makes them stand out vs the rest of the set
3. Flag concerns: low trade count (<50), single-pair only, high DD, etc.
4. Note cross-run consistency where applicable — same indicator combo
   producing similar Sharpe across independent runs is a robustness signal
5. For each recommendation, suggest what to refine in Co-Pilot before deployment

Strategies:
{strategy_list}   ← IR human-readable + metrics + run_id + pair
```

Response parsed into:
```python
{
  "recommendations": [
    {
      "rank": 1,
      "backtest_run_id": "uuid",
      "summary": "...",
      "rationale": "...",
      "suggested_refinement": "..."
    }
  ],
  "skipped": ["uuid1", "uuid2"],   # low trade count etc.
  "skipped_reason": "..."
}
```

---

## Dashboard Monitoring Widget

New widget on the Dashboard page showing active and recent G-Optimize runs:

```
┌─── G-Optimize ──────────────────────────────────────────────────┐
│  Run #3 — EURUSD + GBPUSD · 1H                                  │
│  ████████████████░░░░░░░░░░  64%  (19,200 / 30,000 backtests)   │
│  Passed so far: 31   ETA: ~51 min                               │
│                                                          [Stop]  │
│                                                                  │
│  Last completed: Run #2 · Apr 18 · 103 passed / 60,000 tested   │
│                                               [View Results →]   │
└──────────────────────────────────────────────────────────────────┘
```

Progress data: polls `GET /api/g-optimize/runs/{id}` every 10s while `status = 'running'`.
Only the most recent running + most recent completed run shown on Dashboard.
Full history lives in the G-Optimize panel.

---

## Frontend Files

| File | Notes |
|---|---|
| `src/app/g-optimize/page.tsx` | Main page — Suspense wrapper + `GOptimizeInner` |
| `src/components/GOptimizeRunConfig.tsx` | Run config panel — entry/exit builders, search config, threshold |
| `src/components/GOptimizeRunsList.tsx` | Left runs panel — list, status badges, checkboxes |
| `src/components/GOptimizeStrategies.tsx` | Right strategies panel — passed/failed tabs, checkboxes, promote |
| `src/components/GOptimizeCopilotPanel.tsx` | Bottom Co-Pilot analysis panel — scope selector, analysis output |
| `src/components/GOptimizeProgressWidget.tsx` | Dashboard widget — progress bar, ETA, stop button |
| `src/lib/gOptimizeTypes.ts` | `GOptimizeRun`, `GOptimizeStrategy`, `GOptimizeAnalysis` types |

Dashboard change: add `GOptimizeProgressWidget` to `src/app/dashboard/page.tsx`.
Sidebar change: add G-Optimize entry to `NAV_ITEMS` in `src/components/Sidebar.tsx`.

---

## Build Order

### Step 0 — SIR extensions (prerequisite)
- `engine/parser.py` — handle `exit_mode` and `trailing_stop` fields
- `engine/runner.py` — implement trailing stop logic + exit mode branching
- Unit tests for all three exit modes and trailing stop activation
- **Must be done before any G-Optimize work starts**

### Step 1 — DB + API skeleton
- Migration: `g_optimize_runs` table + `backtest_runs` columns (`source`, `g_optimize_run_id`, `passed_threshold`)
- `routers/g_optimize.py` — CRUD endpoints (no Celery yet)
- Frontend: Runs panel + New Run button (no config form yet)

### Step 2 — Config sampler + Celery task
- `backend/tasks/g_optimize.py` — `ConfigSampler` + orchestrator task
- New `g_optimize` Celery queue
- SSE progress stream
- Frontend: Run Config panel (entry/exit builders, search config, threshold form)
- Frontend: progress bar in Runs panel + Dashboard widget

### Step 3 — Strategies panel + RAG injection
- `GET /api/g-optimize/runs/{id}/strategies` endpoint
- Frontend: Strategies panel — Passed/Failed tabs, checkboxes, inline detail, Promote button
- RAG injection in orchestrator (`embed_and_inject_rag`)
- `POST /api/g-optimize/strategies/{id}/promote` endpoint

### Step 4 — Co-Pilot analysis
- `backend/ai/g_optimize_agent.py` — ranking prompt + parser
- `POST /api/g-optimize/analyze` endpoint
- Frontend: Co-Pilot Analysis panel — scope selector, analysis output, Open in Co-Pilot buttons

### Step 5 — Polish + monitoring
- Dashboard widget
- Near-miss yellow border in Failed tab
- Run delete endpoint + confirmation
- Stop button reliability testing

Estimated PRs: 10–12

---

## Key Risks and Mitigations

| Risk | Mitigation |
|---|---|
| Combinatorial explosion | Random sampling (not grid search); user sets N configs explicitly |
| Celery queue saturation | Separate `g_optimize` queue; interactive backtests unaffected |
| RAG corpus pollution | `source: "g_optimize"` tag; Co-Pilot can filter by source if needed |
| Overfitting to backtest period | User defines train window; threshold requires min 30 trades |
| trades table bloat (3M rows/run) | `store_trades` default = passing only; warning shown in UI |
| Trailing stop engine correctness | Step 0 unit tests with golden fixtures before any G-Optimize runs |
| SSE dropped during long runs | Same `get_message()` polling pattern as optimization SSE (PR #64 fix) |

---

## DB Migration Sequence

| Migration | Contents |
|---|---|
| `0xx_g_optimize_runs.sql` | `g_optimize_runs` table |
| `0xx_backtest_runs_source.sql` | `source`, `g_optimize_run_id`, `passed_threshold` columns on `backtest_runs` |
