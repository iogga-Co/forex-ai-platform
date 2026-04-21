# Forex AI Trading Platform — Claude Code Guide

## Project overview

AI-assisted forex trading platform. Users create strategies via an AI Co-Pilot (Claude), backtest them against historical OHLCV data, optimize with iterative AI refinement, and view results on interactive charts. Live trading (Phase 4) is next.

**Stack:** Next.js 15 (frontend) · FastAPI + uvicorn (backend) · Celery + Redis (task queue) · TimescaleDB + pgvector (database) · Nginx (reverse proxy) · Doppler (secrets) · Docker Compose

**Repo:** https://github.com/iogga-Co/forex-ai-platform  
**Local:** `C:\Projects\forex-ai-platform`  
**Working dir for frontend sessions:** `C:\Projects\forex-ai-platform\frontend`

---

## Phase status

| Phase | Name | Status |
|---|---|---|
| 0 | Foundation | ✅ Complete |
| 1 | Core Engine | ✅ Complete |
| 2 | AI Intelligence | ✅ Complete |
| 3 | Analytics Suite | ✅ Complete |
| 3.5 | Indicator Lab | 🚧 In progress — PR #108 merged (backend); frontend PR 2 next |
| 3.6 | G-Optimize | ✅ Complete — PR #102 |
| 4 | Live Trading | 🚧 In progress — PR #106 open (feed + price ticker) |
| 5 | Production Launch | 🔲 Pending |

---

## Directory structure

```
forex-ai-platform/
├── backend/
│   ├── routers/          # FastAPI route handlers (auth, backtest, strategy, optimization,
│   │                     #   analytics, copilot, candles, trading, ws, diagnosis, lab)
│   ├── engine/           # Backtesting engine (sir.py — SIR schema, parser.py, runner.py,
│   │                     #   indicators.py, metrics.py, filters.py, sizing.py)
│   ├── tasks/            # Celery tasks (backtest.py, optimization.py, g_optimize.py)
│   ├── ai/               # model_router.py (provider dispatch), claude/openai/gemini clients,
│   │                     #   optimization_agent.py, g_optimize_agent.py, Voyage AI retrieval,
│   │                     #   strategy_diagnosis.py, trade_analysis.py, period_diagnosis.py
│   ├── live/             # Phase 4 live trading: oanda.py (OANDA client), feed.py (tick stream)
│   ├── core/             # Config, DB pool, auth (JWT)
│   ├── data/             # OHLCV ingest pipeline, quality checks
│   └── scripts/          # backfill.py — historical data loader; seed_demo.py — demo data seed
├── frontend/
│   └── src/
│       ├── app/          # Next.js pages: backtest, copilot, dashboard, g-optimize, lab (stub),
│       │                 #   live, login, news, optimization, settings, strategies, superchart
│       ├── components/   # BacktestResultPanel, TradeAnalysisSidebar, AuthGuard, etc.
│       └── lib/          # auth.ts, settings.ts, strategyLabels.ts
├── db/migrations/        # SQL migration files (apply manually on existing DB)
├── nginx/                # nginx.conf + certs
├── docker-compose.yml
├── docker-compose.dev.yml  # adds bind mounts + NEXT_PUBLIC_API_URL="" for local hot reload
└── doppler.yaml
```

---

## Running locally

```bash
# Start all services with hot reload (bind mounts via dev override)
doppler run -- docker compose -f docker-compose.yml -f docker-compose.dev.yml up

# Restart only the FastAPI container (required after backend code changes — NO --reload on uvicorn)
doppler run -- docker compose restart fastapi

# Restart only Celery (required after tasks/ changes)
doppler run -- docker compose restart celery

# Production/staging (baked images, no bind mounts)
doppler run -- docker compose up
```

**Critical:** uvicorn runs WITHOUT `--reload`. Backend code changes are NOT picked up automatically. Always `docker compose restart fastapi` after editing backend files.

---

## Staging server

- **Provider:** Contabo VPS
- **IP:** `86.48.16.255` — always SSH to this IP directly, NOT the domain (domain resolves to wrong IP)
- **Domain:** `trading.iogga-co.com` (HTTPS works, SSH does not)
- **OS:** Ubuntu 24.04, user: `root`
- **Project path:** `/opt/forex-ai-platform`
- **Container names:** `forex-ai-platform-fastapi-1`, `forex-ai-platform-celery-1`, `forex-ai-platform-timescaledb-1`

```bash
# SSH
ssh root@86.48.16.255

# Check service health
ssh root@86.48.16.255 "docker compose -f /opt/forex-ai-platform/docker-compose.yml ps"
```

---

## Key architectural patterns

### Strategy Intermediate Representation (SIR)

All strategies are stored as JSON in the `ir_json` / `strategy_ir` columns. Schema defined in `backend/engine/sir.py`:

```json
{
  "entry_conditions": [
    { "indicator": "EMA", "period": 20, "operator": "price_above" },
    { "indicator": "RSI", "period": 14, "operator": ">", "value": 50 }
  ],
  "exit_conditions": {
    "stop_loss":   { "type": "atr", "period": 14, "multiplier": 1.5 },
    "take_profit": { "type": "atr", "period": 14, "multiplier": 3.0 }
  },
  "filters": { "exclude_days": [], "session": "all" },
  "position_sizing": { "risk_per_trade_pct": 1.0, "max_size_units": 100000 }
}
```

Supported indicators: `RSI`, `EMA`, `SMA`, `MACD`, `BB`, `ATR`, `ADX`, `STOCH`  
MACD uses `fast`/`slow`/`signal_period` instead of `period`.  
BB uses `std_dev`. STOCH uses `k_smooth`/`d_period`.

### asyncpg + NUMERIC columns

asyncpg returns PostgreSQL `NUMERIC`/`DECIMAL` as Python `Decimal`. FastAPI serialises `Decimal` as a string, not a number — this breaks frontend `.toFixed()` calls. Always cast:

```python
def _f(v): return float(v) if v is not None else None
```

Apply `_f()` to every NUMERIC column before returning from any endpoint.

### asyncpg JSONB codec

`core/db.py` registers a `json.loads` codec for JSONB columns. `strategy_ir` and `ir_json` arrive as Python dicts, not strings — no manual `json.loads()` needed in route handlers.

### asyncpg timedelta columns

Duration arithmetic (e.g. `exit_time - entry_time`) returns a Python `timedelta`. Convert to minutes with:

```python
def _dur_min(t): return (t["exit_time"] - t["entry_time"]).total_seconds() / 60
```

### Optimization iterations — `strategy_ir` field

`GET /api/optimization/runs/{run_id}/iterations` returns `strategy_ir` (the full SIR JSON) for each iteration. This is used by the frontend to save an iteration as a new strategy and navigate to Backtest / Optimize / Refine / Superchart.

`DELETE /api/optimization/runs/{run_id}/iterations/{iteration_number}` — deletes a single iteration by run ID + iteration number (1-based). Used by the batch delete flow on the Optimization page.

Pattern in `frontend/src/app/optimization/page.tsx` — `saveIterAndNavigate(destination)`:
1. POST to `/api/strategies` with the iteration's `strategy_ir` and a generated name (`[Opt iter N] PAIR TF`)
2. On success, `router.push(destination URL)` with `strategy_id=<new_id>` plus run params pre-filled

`strategy_ir` arrives as a Python dict (decoded by asyncpg JSONB codec) — no `json.loads` needed in the router. On the frontend it may be a plain object or a JSON string depending on caching; always handle both: `typeof rawIr === "string" ? JSON.parse(rawIr) : rawIr`.

### SSE (Server-Sent Events) streams

Optimization progress is streamed via Redis pub/sub → SSE. Pattern in `routers/optimization.py`. The SSE auth dependency is `get_current_user_sse` (token via query param) not the standard Bearer header dependency.

### Celery task queues

- Backtest tasks → default queue
- Optimization tasks → `optimization` queue (separate worker)
- G-Optimize tasks → `g_optimize` queue (dedicated worker, prevents long runs from blocking interactive backtests)

### SIR extensions (Phase 3.6)

`exit_conditions` now supports three new optional fields — all backwards-compatible (existing strategies default to `stops_only` / no trailing):

```json
{
  "exit_conditions": {
    "stop_loss":   { "type": "atr", "period": 14, "multiplier": 1.5 },
    "take_profit": { "type": "atr", "period": 14, "multiplier": 3.0 },
    "exit_mode":   "first",
    "indicator_exits": [
      { "indicator": "RSI", "period": 14, "operator": "<", "value": 30 }
    ],
    "trailing_stop": {
      "enabled": true, "type": "atr", "period": 14,
      "multiplier": 1.5, "activation_multiplier": 1.0
    }
  }
}
```

`exit_mode` values: `"stops_only"` (default) | `"first"` (any condition closes) | `"all"` (conservative fallback = stops_only).  
Trailing stop uses vectorbt `sl_trail=True` — trailing starts immediately from entry (activation threshold requires custom `adjust_sl_func_nb` in vectorbt 0.26.2; deferred).

### G-Optimize — ConfigSampler + RAG injection

`backend/tasks/g_optimize.py` — `ConfigSampler.sample()` generates random valid SIR dicts from `entry_config`/`exit_config` JSONB blobs stored on `g_optimize_runs`.

**`entry_config` format:**
```json
{
  "max_conditions": 3,
  "conditions": [
    { "indicator": "RSI", "period_min": 10, "period_max": 20, "period_step": 5,
      "operator": ">", "value_min": 40, "value_max": 70 }
  ]
}
```

**`exit_config` format:**
```json
{
  "exit_mode": "stops_only",
  "indicator_exits": [],
  "sl": { "type": "atr", "period": 14, "multiplier_min": 1.0, "multiplier_max": 3.0, "multiplier_step": 0.5 },
  "tp": { "type": "atr", "period": 14, "multiplier_min": 1.5, "multiplier_max": 5.0, "multiplier_step": 0.5 },
  "trailing": { "enabled": false },
  "rr_floor": 1.5
}
```

Sampler enforces: MACD `fast < slow`, R:R floor (TP ≥ rr_floor × SL), all parameter values within min/max bounds.

`embed_and_inject_rag()` — called for passing strategies: builds human-readable description, calls Voyage AI embed via `asyncio.run()` (sync Celery context), inserts into `strategies` table with `metadata.source="g_optimize"`, stores embedding, sets `backtest_runs.strategy_id`.

`POST /api/g-optimize/strategies/{id}/promote` — manual RAG injection for failed strategies; runs async in the FastAPI event loop (uses `await voyage_embed()` directly, not `asyncio.run()`).

`POST /api/g-optimize/analyze` — Co-Pilot ranking analysis via `ai/g_optimize_agent.py`. Accepts `scope: "checked"|"run"|"all"`. Filters strategies with < 50 trades into `skipped`. Caps at 30 strategies (sorted by Sharpe). Returns `{recommendations, skipped, skipped_reason, strategy_ids}` where `strategy_ids` maps `backtest_run_id → strategy_id` for Co-Pilot navigation.

### G-Optimize — DB schema additions

`backtest_runs` new columns (migration 018, 019):
- `source VARCHAR(20) DEFAULT 'manual'` — `'manual'|'optimization'|'g_optimize'`
- `g_optimize_run_id UUID` FK to `g_optimize_runs` (ON DELETE SET NULL)
- `passed_threshold BOOLEAN` — NULL for manual/optimization rows
- `sir_json JSONB` — stores sampled SIR for g_optimize rows (strategy_id set only after RAG injection)
- `strategy_id` now **nullable** — g_optimize backtest runs don't have a strategy row until promoted

### pgvector queries

PostgreSQL cannot infer the type of unreferenced `$N` parameters. If multiple queries share a params array and some `$N` indices are skipped, split into separate param arrays — one per query.

---

## AI model routing

`backend/ai/model_router.py` — single entry point. Dispatches based on model ID prefix:
`claude-*` → Anthropic, `gpt-*` → OpenAI, `gemini-*` → Google.

Two public async functions: `get_full_response` (diagnosis, period analysis) and
`stream_chat_copilot` (Co-Pilot SSE). Celery tasks use the sync variants of OpenAI/Gemini clients.

Token usage logged to `ai_usage_log` table (migration 015) — model, feature, input/output counts.

---

## AI Diagnosis endpoints

`backend/routers/diagnosis.py` — prefix `/api/diagnosis`

| Endpoint | Purpose |
|---|---|
| `POST /api/diagnosis/strategy` | Single-strategy weakness analysis — fetches metrics + trades, pre-computes stats, calls Claude, returns up to 3 structured fix suggestions with `ir_patch` objects |
| `POST /api/diagnosis/trades/stats` | Selection vs population trade stats — takes `backtest_run_id` + `trade_ids`; returns win rate, avg PnL/R, duration, MAE/MFE, long/short breakdown, by_hour, by_dow for both the selection and the full run |
| `POST /api/diagnosis/trades/analyze` | AI pattern analysis — takes pre-computed `stats` dict (from `/trades/stats`); calls `ai/trade_analysis.py` → Claude; returns `{headline, patterns, verdict, recommendation}` |

AI modules:
- `backend/ai/strategy_diagnosis.py` — single-strategy diagnosis prompt; dispatches via `model_router`
- `backend/ai/trade_analysis.py` — multi-trade pattern analysis prompt; dispatches via `model_router`
- `backend/ai/period_diagnosis.py` — period + news event analysis; dispatches via `model_router`

All diagnosis request bodies accept a `model: str` field (default `"claude-sonnet-4-6"`). The frontend sends `model: loadSettings().ai_model`.

**Two-step fetch pattern for trade analysis:** call `/trades/stats` first, render the stats, then call `/trades/analyze` with the stats dict. This avoids sending raw trade data to Claude and produces tighter prompts.

Verdict values: `"structural" | "edge_decay" | "outlier" | "inconclusive"`  
Pattern strength values: `"strong" | "moderate" | "weak"`

---

## Frontend conventions

### Button style (toolbar buttons)
```tsx
// Standard action button
"rounded border border-blue-700 px-1.5 py-0.5 text-[10px] text-blue-400 hover:bg-blue-900/30 transition-colors"

// Disabled state for <Link> (not a real button — can't use disabled prop)
"opacity-30 pointer-events-none"

// Delete/trash button
"rounded border border-red-800 p-0.5 text-red-400 hover:bg-red-900/30 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
// Trash icon: h-3 w-3
```

### URL params — passing context between pages

Pages accept URL params to pre-fill forms:

| Page | Accepted params |
|---|---|
| `/backtest` | `strategy_id`, `pair`, `timeframe`, `period_start`, `period_end` |
| `/optimization` | `strategy_id`, `pair`, `timeframe`, `period_start`, `period_end` |
| `/copilot` | `strategy_id`, `pair`, `timeframe`, `backtest_id` |
| `/superchart` | `strategy_id`, `backtest_id` |

### useSearchParams — requires Suspense

Any page component using `useSearchParams()` must be wrapped in `<Suspense>`. Pattern:

```tsx
export default function Page() {
  return <Suspense><PageInner /></Suspense>;
}
function PageInner() {
  const searchParams = useSearchParams();
  // ...
}
```

Without this, Next.js static prerendering crashes at build/lint time.

### RunSummary interface — `strategy_id` required

The `RunSummary` type in both `backtest/page.tsx` and `strategies/page.tsx` must include `strategy_id: string`. The API (`GET /api/backtest/results`) returns this field. It is needed by toolbar buttons (Superchart, Optimize, Refine links) to construct correct URLs. Do not omit it.

### BacktestResultPanel — trade checkboxes + AI analysis

`src/components/BacktestResultPanel.tsx` shows indicator parameters and the trade list with multi-trade selection:

- Compact horizontal Entry/Exit rows — entry conditions in left column, exit (SL/TP) in right column
- Auto-column grid within each row: 1 col (≤2 conditions), 2 col (3–4), 3 col (5+)
- Filters + position sizing rendered as compact chips below the Entry/Exit rows
- No pair/timeframe/version header — that info lives in the toolbar above the list
- Trade table has a checkbox column — `checkedTradeIds: Set<string>` state
- Select-all checkbox uses `ref` callback for `indeterminate` state
- Row click toggles selection; checked rows get `border-blue-800 bg-blue-900/10` tint
- Outlier detection: trades with loss > 2σ below mean loss get a ⚠ icon + tooltip
- "Analyze N trades" button (disabled when `< 2` selected) opens `TradeAnalysisSidebar`
- `toggleTrade(id)` uses `if/else` not ternary (ternary unused-expression is a lint error)

Do not add Optimize/Refine/View IR navigation buttons to this component — those live in the toolbar above each list.

### TradeAnalysisSidebar

`src/components/TradeAnalysisSidebar.tsx` — props: `backtestRunId`, `tradeIds`, `onClose`

Two-step fetch on mount — both requests include `model: loadSettings().ai_model` in the body:
1. POST `/api/diagnosis/trades/stats` → show selection vs population stats table
2. POST `/api/diagnosis/trades/analyze` → show AI patterns + verdict

Strength badge colours: `strong` = red, `moderate` = yellow, `weak` = slate  
Verdict badge colours: `structural` = orange, `edge_decay` = red, `outlier` = blue, `inconclusive` = slate

### strategyLabels utility

`src/lib/strategyLabels.ts` exports:
- `conditionToLabel(c: EntryCondition)` — human-readable entry condition string
- `exitConditionToLabel(ec)` — formats SL/TP as `ATR(14) × 1.5`, `50 pips`, or `2%`
- `filterToLabels(filters, sizing)` — compact filter/sizing chip array

Used by the Co-Pilot Story panel and anywhere SIR needs to be rendered as readable text.

### strategyHealth utility

`src/lib/strategyHealth.ts` — computes health badge ratings (Sharpe / Win Rate / Max DD) from a backtest run. Used in the Strategies tab to show colour-coded badges (green/yellow/red) on each strategy card.

### DiagnosisSidebar

`src/components/DiagnosisSidebar.tsx` — single-strategy AI diagnosis panel. Opened via the "Diagnose" button in the Strategies tab toolbar. POSTs to `POST /api/diagnosis/strategy` and renders up to 3 structured fix suggestions with `ir_patch` objects.

### Co-Pilot IR panel

The IR inspector in `copilot/page.tsx` shows:
- **Story panel** — entry condition cards, exit condition cards, filter/sizing row (uses `strategyLabels`)
- **Action buttons** — Backtest, Optimize, Superchart (no Refine button)
  - Buttons are greyed (`opacity-30 pointer-events-none`) until strategy is saved
  - "Save to enable" hint shown when `!savedId`
  - Backtest/Optimize links include `?strategy_id=&pair=&timeframe=` params

### Superchart toolbar

Backtest / Optimize / Refine buttons live in the **top toolbar** (`ml-auto` div), not the bottom-right corner. Use standard `border-blue-700` button style with `disabled:opacity-30 disabled:cursor-not-allowed`.

### Global CSS density overrides

`src/app/globals.css` overrides Tailwind utilities to keep the UI compact. Do not remove these — they are intentional global tightening, not bugs:

```css
/* Padding compression */
.px-3, .px-4, .px-6 { padding-left: 0.5rem; padding-right: 0.5rem; }
.pl-6               { padding-left: 0.5rem; }
.py-3               { padding-top: 0.5rem; padding-bottom: 0.5rem; }

/* Muted text override */
.text-slate-500 { color: rgb(148 163 184); }   /* slightly lighter than default */

/* Hide number input spinners */
.no-spinner::-webkit-outer-spin-button,
.no-spinner::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
.no-spinner { -moz-appearance: textfield; }
```

### Full-viewport page wrapper (`-m-1`)

`<main>` in `layout.tsx` has `p-1`. Pages that need to fill the viewport edge-to-edge cancel it with `-m-1` on their outermost div:

```tsx
<div className="flex h-full overflow-hidden -m-1">
```

Currently used by: `strategies/page.tsx`, `copilot/page.tsx`. If global padding ever changes, update all `-m-N` wrappers to match.

### fetchWithAuth

All API calls use `fetchWithAuth` from `@/lib/auth` — automatically attaches the JWT Bearer token. Never use raw `fetch()` for authenticated endpoints.

### localStorage keys

- `copilot_system_prompt` — persisted system prompt in Co-Pilot tab; written on every keystroke, read on mount
- `superchart_state` — full Superchart state persisted across navigation: pair, timeframe, date range, active oscillator, osc params, chart overlays, selected strategy/backtest. Restored on mount; URL params (`strategy_id`, `backtest_id`) still take priority. Reset button in toolbar clears it.
- Settings keys managed via `@/lib/settings`

### Batch delete pattern (checkboxes)

Used in Backtest tab history list and Strategies tab (both strategy and backtest lists):
- `checkedIds: Set<string>` state — separate from the highlighted row (`selectedId`)
- Select-all checkbox uses `ref` callback to set `indeterminate` when partial
- **Checkbox position:** placed AFTER the trash icon in the toolbar, not at the front
- Trash button: if `checkedIds.size > 0` → delete all checked; else fall back to single highlighted item
- Count badge shown on trash icon when `checkedIds.size > 1`
- Strategy delete has a confirm/cancel flow; backtest delete is immediate
- Checked rows: `border-blue-800 bg-blue-900/10` tint (distinct from highlighted `bg-blue-900/20`)

### Sortable lists

Strategies tab uses `sortStrategies()` / `sortBacktests()` helpers (defined at top of `strategies/page.tsx`).  
Sort key + direction stored as state; clicking active key toggles direction; clicking new key sets to default direction.  
Sort bar renders below the toolbar, not in the header row.

---

## Database

- **TimescaleDB** (PostgreSQL extension) for OHLCV time-series
- **pgvector** for strategy embedding/retrieval
- Migrations in `db/migrations/` — **only auto-applied on a fresh volume**. For existing deployments, run manually:

```bash
docker exec forex-ai-platform-timescaledb-1 psql -U forex_user -d forex_db -f /path/to/migration.sql
```

### Key tables

| Table | Purpose |
|---|---|
| `strategies` | Strategy records with `ir_json` JSONB |
| `backtest_runs` | Backtest job metadata AND completed run metrics (sharpe, max_dd, win_rate, trade_count, etc.) |
| `trades` | Individual trade records (pnl, r_multiple, mae, mfe, entry_time, exit_time, direction) |
| `optimization_runs` | Optimization session metadata; `model VARCHAR(60)` column (migration 016) |
| `optimization_iterations` | Per-iteration results with `strategy_ir` JSONB |
| `ohlcv_candles` | TimescaleDB hypertable — 6 pairs × 2 stored timeframes (`1m`, `1H`) |
| `ai_usage_log` | Token usage per AI call — model, feature, input/output counts (migration 015) |
| `news_events` | ForexFactory calendar events — `UNIQUE(event_time, currency, title)` |
| `live_orders` | Live trade execution records — status, direction, size, entry/exit prices, SL/TP, R-multiple, shadow_mode (migration 007 + 020) |
| `saved_indicators` | Indicator Lab: named indicator configs (indicator_config JSONB, signal_conditions JSONB) — migration 021 |

**Note:** There is NO separate `backtest_results` table. `backtest_runs` is the single table for both job metadata and result metrics. All diagnosis/analytics queries use `FROM backtest_runs`.

### OHLCV coverage

All 6 pairs fully loaded: `EURUSD`, `GBPUSD`, `USDJPY`, `EURGBP`, `GBPJPY`, `USDCHF`  
Coverage: April 2021 – April 2026 · Stored timeframes: `1m`, `1H`

### On-the-fly timeframe resampling

`data/db.py` `fetch_candles()` and `routers/candles.py` both support 7 timeframes. Only `1m` and `1H` are stored in `ohlcv_candles`. The other 5 are resampled from `1m` at query time using pandas:

| Timeframe | Pandas rule | Source |
|---|---|---|
| `1m` | — | stored |
| `5m` | `5min` | resampled from 1m |
| `15m` | `15min` | resampled from 1m |
| `30m` | `30min` | resampled from 1m |
| `1H` | — | stored |
| `4H` | `4h` | resampled from 1m |
| `1D` | `1D` | resampled from 1m |

OHLCV aggregation: `open=first, high=max, low=min, close=last, volume=sum`. The analytics indicator overlay endpoints scale the 300-bar warmup window by `minutes_per_bar` so indicators are always fully primed regardless of timeframe.

---

## Infrastructure notes

### Nginx

`nginx.conf` must always have top-level `events {}` and `http {}` wrapper blocks. Directives like `limit_req_zone` placed outside these blocks cause nginx to crash at startup.

Nginx resolves upstream hostnames (e.g. `fastapi`) at startup — if nginx restarts while fastapi is down, it fails with `host not found in upstream`. The CI deploy script handles this by recreating backend services first, sleeping 5s, then recreating frontend, then reloading nginx with a restart fallback.

### Docker Compose — bind mounts

Never add source code bind mounts (`./backend:/app`) to the base `docker-compose.yml`. They go in `docker-compose.dev.yml` only. On the server, containers run as a different UID than the deploy user — bind mounts cause EACCES errors (hit this with Next.js `.next/trace`).

### NEXT_PUBLIC_API_URL — local dev

`docker-compose.dev.yml` sets `NEXT_PUBLIC_API_URL: ""` (empty string) on the nextjs service. This forces the browser to use relative URLs routed through nginx — required because Doppler injects `http://localhost:3000` which is only reachable server-side inside the container network, not from the browser.

### Hot reload on Windows (Docker bind mounts)

Next.js with Turbopack (`next dev --turbopack`) ignores `WATCHPACK_POLLING` and `CHOKIDAR_USEPOLLING` on Windows bind-mounted volumes — file changes are never detected. Two fixes applied in combination:

1. `docker-compose.dev.yml` uses `node_modules/.bin/next dev` (webpack, no Turbopack) with env vars:
   ```yaml
   WATCHPACK_POLLING: "true"
   CHOKIDAR_USEPOLLING: "true"
   ```
2. `next.config.ts` sets `config.watchOptions = { poll: 1000, aggregateTimeout: 300 }` in the webpack config — fallback for environments where env vars alone are insufficient.

If hot reload stops working, verify both are present. Do not re-add `--turbopack` to the dev command.

### Docker image tags

Always lowercase the image tag owner prefix. `github.repository_owner` can contain uppercase (`iogga-Co`):

```yaml
echo "IMAGE_PREFIX=ghcr.io/$(echo '${{ github.repository_owner }}' | tr '[:upper:]' '[:lower:]')/forex-ai" >> $GITHUB_ENV
```

### CI pipeline

- `next lint` is deprecated in Next.js 15.5+ — use `eslint src/` with `eslint.config.mjs`
- pytest exit code 5 = no tests collected (not a failure) — handle with `pytest ... || [ $? -eq 5 ]`
- Staging deploy only fires on `push` to main, not `workflow_dispatch`
- `npm ci` requires `package-lock.json` in sync — commit both together after any `npm install`
- **Deploy order matters:** recreate `fastapi celery celery-g-optimize` first → `sleep 5` → recreate `nextjs` → `nginx -s reload`. All three backend services must be listed — `celery-g-optimize` was previously omitted and ran stale code after every deploy.
- **DB migrations in deploy:** CI deploy script runs all migrations via `doppler run -- bash -c 'for f in db/migrations/*.sql; do psql ... -f ...; done'` with `|| true` so already-applied migrations are ignored silently. Migrations are NOT auto-applied on existing volumes — always add a migration file; the CI loop handles it.
- **Nginx reload fallback:** `nginx -s reload 2>/dev/null || docker compose up -d --force-recreate nginx` — if nginx crashed, bring it back rather than exiting CI with code 1.
- **Local main diverges after squash merges** — always create new branches from `origin/main` (`git checkout -b feat/foo origin/main`), never from local `main`.
- **Docker pip install** — Dockerfile uses `pip install --no-cache-dir --retries 5 -r requirements.txt`. The `--retries 5` guards against transient SSL/network errors on the GitHub Actions runner (`ssl.SSLError: [SSL] record layer failure`).
- **CI deploys as root** — both staging and production deploy scripts use `username: root`. Root's `authorized_keys` has the `github-actions-deploy` key. Never use `username: deploy` — if any manual SSH session runs as root and touches the repo, deploy-user `git pull` silently fails due to file ownership conflicts. `set -e` is also present so any deploy step failure aborts loudly.

### Doppler secrets

Secrets injected at runtime via `doppler run --`. Never hardcode secrets. Configs: `development` (local), `staging`, and `production` — all three must be updated when adding new secrets.

---

## Trading

- **Broker:** OANDA REST API
- **Account:** practice (paper trading), `001-001-21125823-001`
- **`LIVE_TRADING_ENABLED`:** `false` (gated flag, Phase 4)
- **AI models:** Anthropic Claude (`claude-sonnet-4-6`, `claude-opus-4-6`), OpenAI (`gpt-4o`, `gpt-4o-mini`), Google Gemini (`gemini-2.5-pro`, `gemini-2.0-flash`, `gemini-2.0-flash-lite`) — selected in Settings, routing via `ai/model_router.py`
- **Embeddings:** Voyage AI (`300 RPM / 1M TPM`) — always uses Voyage regardless of AI model selection

---

## Feature specs

Detailed specs for planned features live in `docs/specs/`:

| Spec | File | Phase | Status |
|---|---|---|---|
| Indicator Lab | `docs/specs/indicator-lab.md` | 3.5 — visual sandbox, AI suggestions, saves as Indicator or Strategy; Superchart overlay integration | 🚧 PR #108 merged (backend); frontend PRs 2–5 in progress |
| G-Optimize | `docs/specs/g-optimize.md` | 3.6 — global automated strategy discovery: random param search → backtest → RAG inject → Co-Pilot ranking | ✅ Complete (PR #102) |
| ML Signal Engine | `docs/specs/ml-engine.md` | 5 — LightGBM model, single inference path for backtest + live, model registry | 🔲 Specced |

---

## Indicator Lab endpoints (`/api/lab`)

`backend/routers/lab.py` — prefix `/api/lab`

| Endpoint | Auth | Purpose |
|---|---|---|
| `POST /api/lab/indicators` | None | Compute indicator series (stateless) — same response schema as analytics overlay |
| `POST /api/lab/signals` | None | Compute signal timestamps from conditions (stateless) |
| `GET /api/lab/indicators/saved` | JWT | List saved indicators for current user |
| `POST /api/lab/indicators/saved` | JWT | Create saved indicator |
| `PUT /api/lab/indicators/saved/{id}` | JWT | Update name / status / config |
| `DELETE /api/lab/indicators/saved/{id}` | JWT | Delete |
| `POST /api/lab/analyze` | SSE | Claude chart analysis (stub — implemented in Lab PR 4) |

`POST /api/lab/indicators` request:
```json
{
  "pair": "EURUSD", "timeframe": "1H",
  "from": "2025-01-01", "to": "2025-04-01",
  "indicators": [
    {"type": "EMA", "params": {"period": 20}, "color": "#3b82f6"},
    {"type": "RSI", "params": {"period": 14}}
  ]
}
```
Response schema identical to `GET /api/analytics/backtest/{id}/indicators` — frontend chart rendering is reused.

`DELETE /api/lab/indicators/saved/{id}` requires `response_model=None` explicitly (FastAPI 204 assertion — `-> None` alone is insufficient in current version).

---

## Live Trading — Phase 4 architecture (`backend/live/`)

`backend/live/oanda.py` — async OANDA v20 client (httpx):
- `stream_prices(pairs)` — async generator yielding `{"type":"tick","pair","bid","ask","time"}` or `{"type":"heartbeat"}`
- `place_market_order(instrument, units, sl_price, tp_price)`
- `close_position(instrument)`, `get_open_positions()`, `get_account_summary()`
- Constructor accepts `base_url`/`stream_url` for testing against a mock

`backend/live/feed.py` — asyncio task registered in FastAPI lifespan:
- Streams all 6 pairs from OANDA, publishes ticks to Redis `ticks:{pair}` channels
- Always runs regardless of `LIVE_TRADING_ENABLED` — the price ticker needs it
- Exponential backoff reconnect on failure (max 60s)

`/ws/prices/{pair}` — WebSocket endpoint in `routers/ws.py`. No auth — relays `ticks:{pair}` from Redis to browser. Frontend uses `wss://{host}/ws/prices/{pair}`.

OANDA instrument format: `EUR_USD` (underscore). Internal format: `EURUSD` (no separator). Conversion handled inside `oanda.py`.

Practice stream URL: `https://stream-fxpractice.oanda.com`
Practice REST URL: `https://api-fxpractice.oanda.com`
