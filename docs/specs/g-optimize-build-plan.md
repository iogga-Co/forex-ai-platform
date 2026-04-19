# G-Optimize Build Plan — 12 PRs

**Spec:** `docs/specs/g-optimize.md`  
**Prerequisite:** PR 1 (SIR extensions) must merge before any other PR starts.  
**Estimated total:** 12 PRs

---

## PR 1 — SIR Extensions *(hard prerequisite — nothing else starts until this is done)*

**Why first:** Every subsequent PR depends on the engine correctly handling `exit_mode`,
indicator-based exits, and trailing stop.

### Files changed

**`backend/engine/sir.py`**
- Add `TrailingStopConfig` model (`type`, `period`, `multiplier`, `activation_multiplier`)
- Add `IndicatorExitCondition` model (same fields as `IndicatorCondition`)
- Extend `ExitConditions`: add `exit_mode: Literal["first", "all", "stops_only"] = "stops_only"`,
  `indicator_exits: list[IndicatorExitCondition] = []`, `trailing_stop: TrailingStopConfig | None = None`
- Existing strategies with no new fields default to `stops_only` — fully backwards compatible

**`backend/engine/parser.py`**
- Add `exit_signals()` method — evaluates `indicator_exits` list, same logic as
  `_evaluate_condition()`, returns boolean Series
- Add `trailing_stop_fraction()` — returns per-bar ATR-based or fixed-pip fraction
  (same pattern as `_stop_fraction()`)

**`backend/engine/runner.py`**
- Build `exits` boolean Series from `parser.exit_signals()` combined with `exit_mode`:
  - `"first"` → pass as `exits=` to vectorbt (any condition closes)
  - `"all"` → only close when indicator exit AND SL/TP both triggered (custom logic after portfolio run)
  - `"stops_only"` → `exits=pd.Series(False, ...)` — current behaviour, unchanged
- Add `tsl_stop=` param to `vbt.Portfolio.from_signals()` when trailing stop is enabled
  (vectorbt supports this natively)
- Add `tsl_th=` for activation threshold

**`backend/tests/test_sir_extensions.py`** *(new)*
- Exit mode `first`: indicator exit fires before SL → trade closes on indicator
- Exit mode `all`: indicator exit fires but SL not hit → trade stays open
- Exit mode `stops_only`: indicator exits ignored
- Trailing stop: activates only after activation threshold is met
- Backwards compat: existing SIR with no new fields parses correctly

### Acceptance criteria
All 80 existing tests pass + new tests green. Golden fixture unaffected
(existing SIR defaults to `stops_only`).

---

## PR 2 — DB Migrations

### Files changed

**`db/migrations/017_g_optimize_runs.sql`**
```sql
CREATE TABLE g_optimize_runs (
    id                  SERIAL PRIMARY KEY,
    user_id             INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status              VARCHAR(20) NOT NULL DEFAULT 'pending',
    pairs               TEXT[]       NOT NULL,
    timeframe           VARCHAR(5)   NOT NULL DEFAULT '1H',
    period_start        DATE         NOT NULL,
    period_end          DATE         NOT NULL,
    n_configs           INTEGER      NOT NULL,
    store_trades        VARCHAR(10)  NOT NULL DEFAULT 'passing',
    entry_config        JSONB        NOT NULL,
    exit_config         JSONB        NOT NULL,
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

**`db/migrations/018_backtest_runs_source.sql`**
```sql
ALTER TABLE backtest_runs
    ADD COLUMN source              VARCHAR(20) NOT NULL DEFAULT 'manual',
    ADD COLUMN g_optimize_run_id   INTEGER REFERENCES g_optimize_runs(id) ON DELETE SET NULL,
    ADD COLUMN passed_threshold    BOOLEAN;

CREATE INDEX idx_backtest_runs_source ON backtest_runs(source);
CREATE INDEX idx_backtest_runs_g_optimize ON backtest_runs(g_optimize_run_id)
    WHERE g_optimize_run_id IS NOT NULL;
```

### Acceptance criteria
Both migrations apply cleanly on staging. Existing `backtest_runs` rows get
`source='manual'`, `g_optimize_run_id=NULL`, `passed_threshold=NULL`. No data loss.

---

## PR 3 — Backend API Skeleton (CRUD, no Celery)

### Files changed

**`backend/routers/g_optimize.py`** *(new)*
- `POST /api/g-optimize/runs` — create run row (status=`pending`), return run ID
- `GET /api/g-optimize/runs` — list all runs for current user
- `GET /api/g-optimize/runs/{id}` — run detail + progress counts
- `DELETE /api/g-optimize/runs/{id}` — blocked if status=`running`
- Stub `GET /runs/{id}/stream`, `POST /runs/{id}/stop`, `GET /runs/{id}/strategies`,
  `POST /strategies/{id}/promote`, `POST /analyze` — return `{"status": "not_implemented"}`

**`backend/main.py`** — register `g_optimize` router with prefix `/api/g-optimize`

### Acceptance criteria
`POST /api/g-optimize/runs` creates a DB row. `GET /api/g-optimize/runs` returns it. CI green.

---

## PR 4 — Frontend Skeleton (Sidebar + Page + Runs Panel)

### Files changed

**`frontend/src/components/Sidebar.tsx`** — add G-Optimize between Indicator Lab and Live in `NAV_ITEMS`

**`frontend/src/lib/gOptimizeTypes.ts`** *(new)*
```ts
interface GOptimizeRun {
  id: number; status: string; pairs: string[]; n_configs: number;
  configs_done: number; configs_passed: number; created_at: string; ...
}
interface GOptimizeStrategy {
  backtest_run_id: string; pair: string; sharpe: number; win_rate: number;
  max_dd: number; trades: number; ir: object; rag_status: string; run_id: number; ...
}
interface GOptimizeAnalysis {
  recommendations: { rank: number; backtest_run_id: string; summary: string;
                      rationale: string; suggested_refinement: string }[];
  skipped: string[];
  skipped_reason: string;
}
```

**`frontend/src/app/g-optimize/page.tsx`** *(new)* — Suspense wrapper + `GOptimizeInner`
with 3-section layout shell

**`frontend/src/components/GOptimizeRunsList.tsx`** *(new)* — runs list, status badges,
checkboxes, `[+ New Run]` button, calls `GET /api/g-optimize/runs`

### Acceptance criteria
G-Optimize in sidebar, page loads, empty runs list renders, `[+ New Run]` is clickable,
no TypeScript errors, `next lint` clean.

---

## PR 5 — Run Config Form (Frontend Only)

### Files changed

**`frontend/src/components/GOptimizeRunConfig.tsx`** *(new)* — full config panel:

- **Entry builder** — indicator rows (type, param ranges min/max/step, operator, value range),
  `[+ Add Condition]` up to 10, max conditions per strategy selector
- **Exit builder** — exit mode radio (`first` / `all` / `stops_only`), indicator exit rows
  (same builder as entry), SL type + ranges, TP type + ranges, trailing stop toggle + ranges,
  R:R floor input
- **Search Config** — pair checkboxes, period date pickers, N configs input, store_trades radio
- **Threshold** — Sharpe / WR / MaxDD / min trades inputs, auto-RAG toggle
- **Estimated runtime** — `Math.round((n_configs * pairs.length * 1.7) / 3600 * 10) / 10` hrs
  shown below Start button, recalculates on any input change
- On submit: `POST /api/g-optimize/runs`, new run appears in Runs list with `○ Pending` badge

### Acceptance criteria
Form validates (N configs ≥ 100, at least 1 pair, at least 1 entry indicator enabled,
TP ≥ RR floor × SL). Submits correctly. Run appears in list. Form resets cleanly after submit.

---

## PR 6 — ConfigSampler + Celery Orchestrator

### Files changed

**`backend/tasks/g_optimize.py`** *(new)*
- `ConfigSampler` class — `sample()` generates a random valid SIR from `entry_config` /
  `exit_config` ranges; enforces R:R floor; discards invalid configs silently and resamples
- `run_g_optimize(run_id)` Celery task — full orchestrator loop:
  - Check Redis stop key `g_optimize:stop:{run_id}` each iteration
  - Sample SIR → run backtest (reuses existing `run_backtest()`) for each pair
  - Store result in `backtest_runs` with `source='g_optimize'`, `g_optimize_run_id`, `passed_threshold`
  - Store trades only if `store_trades` config permits
  - Call `embed_and_inject_rag()` for passing + auto-RAG runs
  - Increment progress counters on `g_optimize_runs`
  - Publish SSE progress event to Redis channel `g_optimize:progress:{run_id}`

**`backend/core/celery_app.py`** — add `g_optimize` queue route:
```python
task_routes = {
    "tasks.g_optimize.*": {"queue": "g_optimize"},
    "tasks.backtest.*":   {"queue": "celery"},
    "tasks.optimization.*": {"queue": "optimization"},
}
```

**`docker-compose.yml`** — add `celery-g-optimize` service:
```yaml
celery-g-optimize:
  command: celery -A core.celery_app worker -Q g_optimize -c 2
  # same env as celery service
```

**`backend/routers/g_optimize.py`** — wire `POST /runs` to enqueue
`run_g_optimize.apply_async()`; wire `POST /runs/{id}/stop` to set Redis stop key

### Acceptance criteria
Submit a small run (50 configs, 1 pair). Celery worker picks it up. `backtest_runs` gains
50 rows all with `source='g_optimize'`. Passing rows have `passed_threshold=TRUE`. Status
transitions `pending → running → done`.

---

## PR 7 — SSE Progress Stream + Dashboard Widget

### Files changed

**`backend/routers/g_optimize.py`** — implement `GET /runs/{id}/stream` SSE:
- `get_message()` polling pattern (same as optimization SSE — no `pubsub.listen()`)
- Auth via `get_current_user_sse` (token query param)
- Events: `progress` (configs_done, configs_passed, eta_seconds), `done`, `error`
- `: keepalive` heartbeat every 20s

**`frontend/src/components/GOptimizeRunsList.tsx`** — subscribe to SSE for active run;
show progress bar + % complete + ETA + Stop button while `status='running'`

**`frontend/src/components/GOptimizeProgressWidget.tsx`** *(new)* — compact dashboard widget:
- Active run: progress bar, ETA, Stop button
- Most recent completed run: summary (N passed / N tested) + `[View Results →]`

**`frontend/src/app/dashboard/page.tsx`** — add `GOptimizeProgressWidget`

### Acceptance criteria
Progress bar updates live during a run. Stop button halts gracefully (status → `stopped`,
partial results visible). Widget appears on Dashboard only when at least one run exists.

---

## PR 8 — Strategies Panel + RAG Injection

### Files changed

**`backend/routers/g_optimize.py`** — implement `GET /runs/{id}/strategies`:
- Query params: `tab` (passed/failed), `sort` (sharpe/win_rate/max_dd/trades), `page`,
  `run_ids[]` (multi-run merged view)
- Returns paginated list with `rag_status` field (`in_rag` / `pending` / `none`)

**`backend/tasks/g_optimize.py`** — implement `embed_and_inject_rag()`:
- Build human-readable description (IR + metrics)
- Call Voyage AI embed (existing pipeline)
- Insert into `strategies` table with `name="[G-Opt] {pair} {TF} {date}"`,
  `source='g_optimize'`
- Insert embedding into pgvector

**`frontend/src/components/GOptimizeStrategies.tsx`** *(new)*
- Passed / Failed tabs with counts
- Sortable table: pair, indicator summary, Sharpe, WR, MaxDD, trades, RAG status
- Checkboxes per row + Select All / Clear buttons
- Near-miss detection: rows within 10% of any threshold get a yellow left border
- `[▸]` expands inline detail: full IR human-readable + all metrics + `[Open in Co-Pilot →]`
- Multi-run merged view: run section headers when multiple runs checked in Runs panel

### Acceptance criteria
Strategies appear in correct tab. Passing strategies queryable from Co-Pilot RAG.
Near-misses have yellow left border. `[Open in Co-Pilot →]` navigates to
`/copilot?strategy_id=X`. Pagination works for large result sets.

---

## PR 9 — Manual Promote + Failed Tab Polish

### Files changed

**`backend/routers/g_optimize.py`** — implement `POST /strategies/{backtest_id}/promote`:
- Sets `passed_threshold=TRUE`
- Triggers `embed_and_inject_rag()` synchronously (single Voyage embed — fast)
- Returns updated `rag_status='in_rag'`

**`frontend/src/components/GOptimizeStrategies.tsx`**
- `[Promote to RAG]` button per row in Failed tab — calls promote endpoint, shows
  `Promoting...` spinner, updates status inline without page reload
- Failed tab sorted Sharpe desc by default

**`frontend/src/components/GOptimizeRunsList.tsx`** — delete run confirmation modal
(shows run summary, blocked if `status='running'`)

### Acceptance criteria
Promoting a failed strategy makes it retrievable by Co-Pilot RAG within one request.
Status column updates inline. Deleting a run removes it and its `backtest_runs` rows.

---

## PR 10 — Co-Pilot Analysis Backend

### Files changed

**`backend/ai/g_optimize_agent.py`** *(new)*
- `build_ranking_prompt(strategies: list[dict]) → str` — constructs analysis prompt with
  IR human-readable + metrics + run provenance; notes cross-run consistency where applicable
- `parse_ranking_response(response: str) → dict` — extracts structured recommendations
- `analyze_and_rank(strategies, model) → dict` — calls `get_full_response()` via
  `model_router`; respects user's selected AI model from Settings

**`backend/routers/g_optimize.py`** — implement `POST /api/g-optimize/analyze`:
- Accepts `{ backtest_run_ids: [], scope: "checked"|"run"|"all", model: str }`
- Resolves strategy IDs based on scope:
  - `"checked"` → exact IDs from request
  - `"run"` → all `passed_threshold=TRUE` rows for checked run IDs
  - `"all"` → all `passed_threshold=TRUE` AND `source='g_optimize'` rows for user
- Calls `analyze_and_rank()`
- Returns `{ recommendations: [...], skipped: [...], skipped_reason: str }`

### Acceptance criteria
Sending 5 passing strategies returns 2–3 ranked recommendations with rationale and
suggested refinements. Works with all 3 AI providers (Claude/GPT/Gemini) via model_router.
Strategies with < 50 trades are flagged in `skipped`.

---

## PR 11 — Co-Pilot Analysis Frontend

### Files changed

**`frontend/src/components/GOptimizeCopilotPanel.tsx`** *(new)*
- Selection summary: "X runs · Y strategies selected"
- Scope radio: `Checked strategies only` / `All passed from checked runs` /
  `All passed from all runs`
- `[✦ Send to Co-Pilot for Analysis]` button — calls `POST /api/g-optimize/analyze`,
  shows loading spinner
- Renders ranked recommendations:
  - Rank badge (★ #1, ★ #2, etc.)
  - Strategy summary line (indicators + pair + Sharpe)
  - Rationale paragraph
  - Suggested refinement line
  - `[Open in Co-Pilot →]` button → `/copilot?strategy_id=X`
- Skipped strategies note
- Empty state: "Select strategies above to begin analysis"

**`frontend/src/app/g-optimize/page.tsx`** — wire checkbox state from Runs + Strategies
panels into Co-Pilot panel; derive selected IDs per scope option

### Acceptance criteria
All 3 scope options send correct strategy IDs. Recommendations render correctly.
`[Open in Co-Pilot →]` navigates with correct `strategy_id`. Empty state and loading
state handled gracefully.

---

## PR 12 — Polish + CI Hardening

### Files changed

**`frontend/src/components/GOptimizeRunConfig.tsx`**
- Estimated runtime recalculates reactively on all input changes
- Pair count + N configs validation error messages inline

**`backend/tests/test_g_optimize_sampler.py`** *(new)*
- R:R floor enforced: TP multiplier always ≥ floor × SL multiplier
- Parameter ranges respected: all sampled values within min/max bounds
- Exit mode distribution: all 3 modes appear across 1,000 samples
- Max entry conditions respected: never exceeds user-configured max

**`backend/tests/test_g_optimize_api.py`** *(new)*
- `POST /runs` → creates row, returns ID
- `GET /runs` → returns user's runs only
- `GET /runs/{id}/strategies?tab=passed` → returns only `passed_threshold=TRUE` rows
- `POST /strategies/{id}/promote` → sets `passed_threshold=TRUE`, triggers embed
- `POST /analyze` → returns ranked recommendations

**`docker-compose.dev.yml`** — add `celery-g-optimize` service with bind mounts

### Acceptance criteria
All 80+ existing tests pass + new sampler and API tests green. CI pipeline green.
A G-Optimize run that survives a container restart mid-run resumes from correct
status (reads from DB on startup, not in-memory state).

---

## Dependency Map

```
PR 1 (SIR extensions)
  └── PR 2 (DB migrations)
        └── PR 3 (API skeleton)
              ├── PR 4 (Frontend skeleton)
              │     └── PR 5 (Run config form)
              │           └── PR 6 (Sampler + Celery)
              │                 ├── PR 7 (SSE + Dashboard)
              │                 └── PR 8 (Strategies panel + RAG)
              │                       ├── PR 9 (Promote + polish)
              │                       └── PR 10 (Co-Pilot backend)
              │                             └── PR 11 (Co-Pilot frontend)
              │                                   └── PR 12 (Polish + tests)
```

---

## PR Summary Table

| PR | What | Key new files | Blocks |
|---|---|---|---|
| 1 | SIR extensions — exit_mode, indicator exits, trailing stop | `sir.py`, `parser.py`, `runner.py`, `test_sir_extensions.py` | All others |
| 2 | DB migrations | `017_g_optimize_runs.sql`, `018_backtest_runs_source.sql` | 3, 6, 8 |
| 3 | API skeleton (CRUD stubs) | `routers/g_optimize.py`, `main.py` | 4, 6 |
| 4 | Frontend skeleton — sidebar, page, runs list | `Sidebar.tsx`, `page.tsx`, `GOptimizeRunsList.tsx`, `gOptimizeTypes.ts` | 5 |
| 5 | Run config form (entry/exit builders, search config, threshold) | `GOptimizeRunConfig.tsx` | 6 |
| 6 | ConfigSampler + Celery orchestrator | `tasks/g_optimize.py`, `celery_app.py`, `docker-compose.yml` | 7, 8 |
| 7 | SSE progress stream + dashboard widget | SSE endpoint, `GOptimizeProgressWidget.tsx`, `dashboard/page.tsx` | — |
| 8 | Strategies panel + RAG injection | `GOptimizeStrategies.tsx`, `embed_and_inject_rag()`, strategies endpoint | 9, 10 |
| 9 | Manual promote + delete run | promote endpoint + button, delete modal | 11 |
| 10 | Co-Pilot analysis backend | `g_optimize_agent.py`, analyze endpoint | 11 |
| 11 | Co-Pilot analysis frontend | `GOptimizeCopilotPanel.tsx` | 12 |
| 12 | Polish + CI hardening | sampler tests, API tests, form polish | — |
