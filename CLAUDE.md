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
| 4 | Live Trading | 🔲 Next |
| 5 | Production Launch | 🔲 Pending |

---

## Directory structure

```
forex-ai-platform/
├── backend/
│   ├── routers/          # FastAPI route handlers (auth, backtest, strategy, optimization, analytics, copilot, candles, trading, ws)
│   ├── engine/           # Backtesting engine (sir.py — SIR schema, parser.py, runner.py, indicators.py, metrics.py, filters.py, sizing.py)
│   ├── tasks/            # Celery tasks (backtest.py, optimization.py)
│   ├── ai/               # Claude client, optimization agent, Voyage AI retrieval
│   ├── core/             # Config, DB pool, auth (JWT)
│   ├── data/             # OHLCV ingest pipeline, quality checks
│   └── scripts/          # backfill.py — historical data loader
├── frontend/
│   └── src/
│       ├── app/          # Next.js pages: backtest, copilot, dashboard, live, login, optimization, settings, strategies, superchart
│       ├── components/   # BacktestResultPanel, AuthGuard, etc.
│       └── lib/          # auth.ts, settings.ts
├── db/migrations/        # SQL migration files (apply manually on existing DB)
├── nginx/                # nginx.conf + certs
├── docker-compose.yml
├── docker-compose.dev.yml  # adds bind mounts for local hot reload
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

### Optimization iterations — `strategy_ir` field

`GET /api/optimization/runs/{run_id}/iterations` returns `strategy_ir` (the full SIR JSON) for each iteration. This is used by the frontend to save an iteration as a new strategy and navigate to Backtest / Optimize / Refine / Superchart.

Pattern in `frontend/src/app/optimization/page.tsx` — `saveIterAndNavigate(destination)`:
1. POST to `/api/strategies` with the iteration's `strategy_ir` and a generated name (`[Opt iter N] PAIR TF`)
2. On success, `router.push(destination URL)` with `strategy_id=<new_id>` plus run params pre-filled

`strategy_ir` arrives as a Python dict (decoded by asyncpg JSONB codec) — no `json.loads` needed in the router. On the frontend it may be a plain object or a JSON string depending on caching; always handle both: `typeof rawIr === "string" ? JSON.parse(rawIr) : rawIr`.

### SSE (Server-Sent Events) streams

Optimization progress is streamed via Redis pub/sub → SSE. Pattern in `routers/optimization.py`. The SSE auth dependency is `get_current_user_sse` (token via query param) not the standard Bearer header dependency.

### Celery task queues

- Backtest tasks → default queue
- Optimization tasks → `optimization` queue (separate worker)

### pgvector queries

PostgreSQL cannot infer the type of unreferenced `$N` parameters. If multiple queries share a params array and some `$N` indices are skipped, split into separate param arrays — one per query.

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

### BacktestResultPanel — indicator display, no action buttons

`src/components/BacktestResultPanel.tsx` shows the strategy's indicator parameters inline (no Optimize/Refine/View IR buttons). The display reads `strategy.ir_json` and renders:
- Entry conditions as `key=value` chips (only fields actually present in the IR)
- Exit conditions (SL/TP) formatted as `ATR(14) × 1.5`, `50 pips`, or `2%`
- Filters and position sizing on a compact single row
- Auto-column grid: 1 col (≤2 conditions), 2 col (3–4), 3 col (5+)

Do not add navigation buttons back to this component — those live in the toolbar above each list.

### fetchWithAuth

All API calls use `fetchWithAuth` from `@/lib/auth` — automatically attaches the JWT Bearer token. Never use raw `fetch()` for authenticated endpoints.

### localStorage keys

- `copilot_system_prompt` — persisted system prompt in Co-Pilot tab; written on every keystroke, read on mount
- Settings keys managed via `@/lib/settings`

### Batch delete pattern (checkboxes)

Used in Backtest tab history list and Strategies tab (both strategy and backtest lists):
- `checkedIds: Set<string>` state — separate from the highlighted row (`selectedId`)
- Select-all checkbox uses `ref` callback to set `indeterminate` when partial
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
| `backtest_runs` | Backtest job metadata |
| `backtest_results` | Completed run metrics |
| `trades` | Individual trade records |
| `optimization_runs` | Optimization session metadata |
| `optimization_iterations` | Per-iteration results with `strategy_ir` JSONB |
| `ohlcv_candles` | TimescaleDB hypertable — 6 pairs × 2 timeframes |

### OHLCV coverage

All 6 pairs fully loaded: `EURUSD`, `GBPUSD`, `USDJPY`, `EURGBP`, `GBPJPY`, `USDCHF`  
Coverage: April 2021 – April 2026 · Timeframes: `1m`, `1H`

---

## Infrastructure notes

### Nginx

`nginx.conf` must always have top-level `events {}` and `http {}` wrapper blocks. Directives like `limit_req_zone` placed outside these blocks cause nginx to crash at startup.

### Docker Compose — bind mounts

Never add source code bind mounts (`./backend:/app`) to the base `docker-compose.yml`. They go in `docker-compose.dev.yml` only. On the server, containers run as a different UID than the deploy user — bind mounts cause EACCES errors (hit this with Next.js `.next/trace`).

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

### Doppler secrets

Secrets injected at runtime via `doppler run --`. Never hardcode secrets. Configs: `development` (local) and `staging`.

---

## Trading

- **Broker:** OANDA REST API
- **Account:** practice (paper trading), `001-001-21125823-001`
- **`LIVE_TRADING_ENABLED`:** `false` (gated flag, Phase 4)
- **AI model:** Claude (`claude-sonnet-4-6` or `claude-opus-4-6`)
- **Embeddings:** Voyage AI (`300 RPM / 1M TPM`)
