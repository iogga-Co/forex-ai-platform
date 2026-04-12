# Forex AI Platform — Project Status

**Last updated:** 2026-04-11 (indicator overlays + oscillator panes + synchronized crosshair on backtest results chart)

---

## Phase Progress

| Phase | Name | Status | Gate Passed |
|---|---|---|---|
| **0** | Foundation | ✅ Complete | ✅ Health check returns 200 over HTTPS |
| **1** | Core Engine | ✅ Complete | ✅ 58 tests pass, CI green, PR #7 merged, staging live |
| **2** | AI Intelligence | ✅ Complete | ✅ Strategy created → backtest runs → results stored. AI summary live (Anthropic key updated 2026-04-10) |
| **3** | Analytics Suite | ✅ Complete | ✅ 283 trades stored, equity curve 283 pts, all /api/analytics endpoints live |
| **4** | Live Trading | 🔲 Next | Pending |
| **5** | Production Launch | 🔲 Pending | Pending |

---

## Current Staging State (2026-04-11)

| Item | Value |
|---|---|
| URL | https://trading.iogga-co.com |
| Health | ✅ 200 OK |
| Services | All 8 up (nginx, fastapi, celery, nextjs, timescaledb, redis, prometheus, grafana) — ClickHouse removed |
| Strategies in DB | 1 (Golden RSI+EMA, EURUSD 1H) |
| Backtest runs in DB | 4+ |
| Trades in DB | 283+ |
| OANDA mode | `practice` (demo account, account 001-001-21125823-001) |
| `LIVE_TRADING_ENABLED` | `false` |
| Anthropic API | ✅ Key updated — credits available |
| Voyage AI | ✅ Payment method added — 300 RPM / 1M TPM |

### OHLCV Data Coverage

| Pair | 1m | 1H | Coverage |
|---|---|---|---|
| EURUSD | ✅ 1,857,300 | ✅ 31,134 | Apr 2021 – Apr 2026 |
| GBPUSD | ✅ 1,857,406 | ✅ 31,143 | Apr 2021 – Apr 2026 |
| USDJPY | ✅ 1,859,916 | ✅ 31,130 | Apr 2021 – Apr 2026 |
| EURGBP | ✅ 1,854,281 | ✅ 31,129 | Apr 2021 – Apr 2026 |
| GBPJPY | ✅ 1,857,964 | ✅ 31,139 | Apr 2021 – Apr 2026 |
| USDCHF | ✅ 1,846,046 | ✅ 31,134 | Apr 2021 – Apr 2026 (backfill completed 2026-04-11 08:43 UTC) |

---

## Phase 0 — Foundation ✅

**Gate passed 2026-04-05.**

### Deliverables
- GitHub repo with branch protection — CI must pass before merge (6 jobs)
- Docker Compose — 8 services: nginx, fastapi, celery, nextjs, timescaledb, redis, prometheus, grafana (ClickHouse removed in code quality pass)
- Doppler secrets management — `development` and `staging` configs
- Staging VPS (Contabo, Ubuntu 24.04, 86.48.16.255) with UFW + Contabo network firewall (both must allow port 22)
- SSL via Let's Encrypt — `trading.iogga-co.com`, expires 2026-07-04
- Nginx — SSL termination, HTTP→HTTPS redirect, rate limiting (100 req/min), WebSocket upgrade
- FastAPI skeleton — JWT auth, health check, WebSocket hub
- Next.js 15 — TypeScript, Tailwind CSS, 5 routes
- DB migrations — 9 tables with indexes, pgvector, TimescaleDB hypertable

### Key lessons
- Nginx has no `events {}` / `http {}` wrapper blocks → nginx fails to start silently
- `version` key in docker-compose.yml is obsolete — causes warnings but not failures
- Contabo VPS has TWO firewalls: ufw (OS-level) AND Contabo network-level control panel — both must allow port 22

---

## Phase 1 — Core Engine ✅

**Gate passed 2026-04-06.** PR #7 merged. 58 tests pass.

### Deliverables
- Data pipeline: `OHLCVBar` model, quality checks, Dukascopy downloader, yfinance ingest, bulk DB insert
- Backtesting engine: SIR schema, 8 indicators (RSI/EMA/SMA/MACD/BB/ATR/ADX/Stochastic), filters, ATR sizing, vectorbt runner
- Celery task: fetch → validate → run → store → publish progress via WebSocket
- API: POST /api/backtest, GET /api/backtest/jobs/{id}/status, GET /api/backtest/results/{id}
- Strategy CRUD: POST/GET /api/strategies
- 58 unit tests (38 indicator, 12 SIR parser, 7 golden regression, 3 health)
- Backfill script: `backend/scripts/backfill.py` (idempotent, Dukascopy LZMA .bi5)

### Key lessons
- `vectorbt==0.26.2` requires `numpy==1.26.4` (<2.0) and `plotly==5.11.0` (heatmapgl removed in ≥5.12)
- `NUMBA_CACHE_DIR=/tmp/numba_cache` required in Docker (non-root user)
- `backend/data/` was excluded by `.gitignore`'s `data/` pattern — fixed with `!backend/data/` exception
- Golden fixture: must regenerate with `python tests/fixtures/generate_golden.py` after intentional engine changes

---

## Phase 2 — AI Intelligence ✅

**Gate passed 2026-04-09.** PRs #10–#18 merged. Strategy → backtest → results confirmed end-to-end.

### Deliverables
- Claude client: `stream_chat()`, `extract_sir_from_response()`, `summarize_backtest()` — uses ` ```sir ` fenced block format
- Voyage AI: 1024-dim embeddings with Redis cache (TTL=7d)
- Hybrid RAG: pgvector cosine + BM25 full-text fused with RRF (`_TOP_N=6`, `_RRF_K=60`)
- Copilot API: POST /api/copilot/chat (SSE stream: `text`/`sir`/`error`/`done`), GET /api/copilot/sessions/{id}
- Auto-summary: Claude summarises each backtest result, Voyage embeds it, stored on `backtest_runs`
- Frontend: copilot split-view chat + SIR inspector, strategies list with expandable IR viewer
- 11 new tests (SIR extraction, RRF fusion, Voyage cache, summarisation, router 404)

### Key lessons
- Celery `ForkPoolWorker` changes CWD — lazy imports fail without `PYTHONPATH=/app`
- Nginx caches upstream IPs at startup — must run `nginx -s reload` after container rebuilds
- `voyageai` latest = `0.2.4`, not `0.3.x`
- AI auto-summary blocked by Anthropic API credit balance (needs top-up at console.anthropic.com)
- TimescaleDB `initdb` migrations only run on fresh volume — new SQL files must be applied manually with `psql` on existing DB

---

## Phase 3 — Analytics Suite ✅

**Gate passed 2026-04-09.** PRs #20–#23 merged. EURUSD 1H backtest: 283 trades, equity curve 283 points, correct drawdown series.

### Deliverables
- `backend/routers/analytics.py` — `GET /api/analytics/backtest/{id}/equity-curve` (cumulative PnL + drawdown via SQL window functions), `GET /api/analytics/backtest/{id}/export-csv` (trades CSV), `GET /api/analytics/strategies/compare` (multi-strategy aggregation)
- `backend/tests/test_analytics.py` — async mock endpoint tests for equity curve, empty trades, 404
- `grafana/provisioning/` — Prometheus datasource + dashboard file provider
- `grafana/dashboards/system.json` — HTTP rate/latency/errors, Celery active tasks, uptime
- `grafana/dashboards/backtests.json` — backtest throughput, p95 latency, copilot calls/min
- `docker-compose.yml` — grafana volume mounts added

### Key fixes
- asyncpg 0.30 returns `jsonb` columns as raw strings — registered `json`/`jsonb` type codecs on `init_pool()` (fixed 500 on `GET /api/strategies`)
- `vectorbt.trades.records_readable` Entry/Exit Index timestamps do not match UTC-aware `df.index` — switched to `records.iloc[i]["entry_idx"]` integer positions (fixed all trades silently skipped → equity curve always empty)
- ClickHouse `init_schema()` never called — added `worker_ready` Celery signal handler
- Frontend: `useRef` missing from React imports; `package-lock.json` not regenerated after adding recharts

### Outstanding items
- EURGBP 1H + GBPJPY 1m/1H backfill still in progress (non-blocking)
- AI auto-summary still blocked by Anthropic credit balance
- Frontend backtest page is currently a placeholder stub — full form + results page exists at `/backtest/results/[id]`

---

## Phase 4 — Live Trading (Next)

**Goal:** Run the backtest engine's signal logic against a live OANDA price stream. Place paper trades automatically on the OANDA practice account. Operator can flip to real money via a single Doppler flag.

### Architecture overview

```
OANDA Streaming API (tick feed)
        │
        ▼
backend/live/feed.py          — asyncio task: subscribe to OANDA v20 stream, publish ticks to Redis pub/sub channel "ticks:{pair}"
        │
        ▼
Redis pub/sub "ticks:{pair}"
        │
        ├──► backend/live/engine.py   — subscribes to tick feed; on each completed 1m/1H bar, runs SIR signal logic; emits trade signals
        │
        ├──► backend/routers/ws.py    — forwards ticks to frontend WebSocket clients (price ticker)
        │
        └──► backend/live/executor.py — receives trade signals; submits market orders to OANDA v20 REST; writes to live_orders table; publishes fills to Redis
                │
                ▼
        frontend live page           — position table, open orders, equity ticker (via WebSocket)
```

### What to build

**Step 1 — OANDA client (`backend/live/oanda.py`)**
- Thin wrapper around OANDA v20 REST API using `httpx` (already a dep)
- Functions: `stream_prices(pairs)` async generator, `place_market_order(account, instrument, units)`, `close_position(account, instrument)`, `get_open_positions(account)`, `get_account_summary(account)`
- Auth via `OANDA_API_KEY` header; base URL switches on `OANDA_ENVIRONMENT` (`practice` vs `live`)
- Unit-testable: constructor accepts base URL so tests can point to a local mock

**Step 2 — Tick feed (`backend/live/feed.py`)**
- Async task that streams `EURUSD,GBPUSD,USDJPY,EURGBP,GBPJPY` ticks from OANDA
- Publishes each tick as JSON to Redis channel `ticks:{pair}` (e.g. `ticks:EURUSD`)
- Reconnects automatically on disconnect (exponential backoff, max 60s)
- Publishes heartbeat `ping` messages every 10s so frontend can detect stale feed
- Registered in FastAPI `lifespan` so it starts/stops with the server
- `LIVE_TRADING_ENABLED=false` → feed still runs (needed for price ticker), but executor is disabled

**Step 3 — Bar builder (`backend/live/bars.py`)**
- Aggregates ticks into completed OHLCV bars (1m and 1H)
- Emits a `BarComplete` event when a bar closes (on first tick of the next bar)
- Does NOT use TimescaleDB for live bars — keeps last N bars in memory (ring buffer, N=500)
- Persists completed bars to `ohlcv_candles` table for continuity with backtest data

**Step 4 — Signal engine (`backend/live/engine.py`)**
- Loads all strategies from DB at startup; reloads on a `SIGHUP` or admin endpoint
- On each `BarComplete` event: runs `SIRParser` on the ring buffer + current bar, checks for entry signal
- If entry signal and `LIVE_TRADING_ENABLED=true` → emits `TradeSignal` to executor
- If `LIVE_TRADING_ENABLED=false` → logs signal but does not execute ("shadow mode")
- One engine instance per strategy; runs as an asyncio coroutine (not Celery — latency-sensitive)

**Step 5 — Order executor (`backend/live/executor.py`)**
- Receives `TradeSignal` → calls `oanda.place_market_order()`
- Writes to `live_orders` table: `status=pending` before submit, `status=filled` on confirmation
- Calculates position size from SIR ATR sizing (same logic as backtest, but on live bars)
- Monitors open positions: polls OANDA every 5s for fill/SL/TP events; updates `live_orders.status`
- On SL/TP hit: updates `live_orders.closed_at`, `exit_price`, `pnl`
- Kill switch: `POST /api/trading/kill-switch` → close all positions via OANDA, set all `live_orders` to `cancelled`, disable executor

**Step 6 — API updates (`backend/routers/trading.py`)**
Replace stubs with real implementations:
- `GET /api/trading/status` — query OANDA account summary; count open positions from DB
- `POST /api/trading/kill-switch` — close all positions; already routed in main.py
- `GET /api/trading/positions` — return open `live_orders` rows with unrealised P&L from OANDA
- `GET /api/trading/history` — paginated closed `live_orders`

**Step 7 — WebSocket price feed (`backend/routers/ws.py` update)**
- Add `ws://` channel `/ws/prices/{pair}` that relays from Redis `ticks:{pair}`
- Frontend subscribes per-pair; gets `{pair, bid, ask, time}` messages

**Step 8 — New DB migration**
- `db/migrations/010_live_orders_sl_tp.sql` — add `sl_price`, `tp_price`, `r_multiple` columns to `live_orders`; add `shadow_mode` boolean column (signal logged but not executed)

**Step 9 — Frontend live page (`frontend/src/app/live/page.tsx`)**
Replace placeholder stub with:
- Price ticker strip at top (5 pairs, bid/ask, spread) — subscribes to `/ws/prices/{pair}`
- Open positions table: pair, direction, size, entry price, current price, unrealised P&L, age
- Signal log: last 20 signals (shadow + executed), timestamp, pair, direction, entry/SL/TP
- Kill switch button (red, requires confirmation dialog) — POST /api/trading/kill-switch
- Engine status badge: `SHADOW MODE` / `LIVE (PRACTICE)` / `LIVE (REAL)` based on API response

**Step 10 — Tests**
- `backend/tests/test_live_oanda.py` — mock OANDA HTTP: stream prices, place order, close position
- `backend/tests/test_live_bars.py` — tick aggregation: bar completion, ring buffer, persistence
- `backend/tests/test_live_engine.py` — signal emission: entry detected, shadow mode suppresses execution
- `backend/tests/test_live_executor.py` — order lifecycle: pending → filled → closed; kill switch

### Existing scaffolding already in place
- `db/migrations/007_live_orders.sql` — `live_orders` table with all core columns ✅
- `backend/routers/trading.py` — stub router with `GET /status`, `POST /enable`, `POST /kill-switch` ✅
- `backend/core/config.py` — `oanda_api_key`, `oanda_account_id`, `oanda_environment`, `live_trading_enabled` fields ✅
- OANDA credentials in Doppler staging config: key set, account `001-001-21125823-001`, environment `practice` ✅
- `frontend/src/app/live/page.tsx` — stub page ✅

### Gate test
1. Set `LIVE_TRADING_ENABLED=false` (shadow mode) in Doppler staging
2. Start the live feed and engine
3. Wait for an entry signal on any pair
4. Confirm the signal appears in the signal log on the live page with `SHADOW` badge
5. Set `LIVE_TRADING_ENABLED=true`
6. Wait for next signal
7. Confirm order appears in OANDA practice account and in the live positions table

---

## Phase 5 — Production Launch

**Goal:** Harden, monitor, and provision a separate production VPS. Real-money trading stays disabled by default.

### What to build
- Production VPS provisioning (separate Contabo server, identical Docker stack)
- Grafana alerting rules — p95 latency >2s, error rate >1%, max_dd breach, position size anomaly
- Structured JSON logging — ship to persistent storage (Loki or log file rotation)
- Operator runbook — documented checklist before enabling `LIVE_TRADING_ENABLED=true` on production
- Load test — 100 concurrent WebSocket connections, 10 req/s backtest submissions

### Gate test
Production smoke test passes (all 9 services healthy). Grafana shows all green. Runbook reviewed and signed off.

---

## Staging Environment

| Item | Value |
|---|---|
| URL | https://trading.iogga-co.com |
| Server IP | 86.48.16.255 |
| Provider | Contabo VPS |
| Deploy user | `deploy` |
| Project path | `/opt/forex-ai-platform` |
| Secrets | Doppler `staging` config |
| OANDA mode | `practice` (account 001-001-21125823-001) |

### Useful commands
```bash
# SSH
ssh -i ~/.ssh/forex-ai-deploy -o IdentitiesOnly=yes deploy@trading.iogga-co.com

# Service status
ssh -i ~/.ssh/forex-ai-deploy -o IdentitiesOnly=yes deploy@trading.iogga-co.com \
  "docker compose -f /opt/forex-ai-platform/docker-compose.yml ps"

# FastAPI logs
ssh -i ~/.ssh/forex-ai-deploy -o IdentitiesOnly=yes deploy@trading.iogga-co.com \
  "docker compose -f /opt/forex-ai-platform/docker-compose.yml logs fastapi --tail=50"

# Celery logs
ssh -i ~/.ssh/forex-ai-deploy -o IdentitiesOnly=yes deploy@trading.iogga-co.com \
  "docker compose -f /opt/forex-ai-platform/docker-compose.yml logs celery --tail=50"

# Health check
curl https://trading.iogga-co.com/api/health

# Candle data state
docker exec forex-ai-platform-timescaledb-1 sh -c \
  'psql -U $POSTGRES_USER $POSTGRES_DB -c "SELECT pair, timeframe, COUNT(*), MAX(timestamp)::date FROM ohlcv_candles GROUP BY pair, timeframe ORDER BY pair, timeframe;"'

# Resume/trigger backfill for any pair (run inside fastapi container)
# Script path is /app/scripts/backfill.py  (NOT /app/backend/scripts/backfill.py)
docker exec forex-ai-platform-fastapi-1 bash -c \
  'BACKFILL_PAIRS=USDCHF python scripts/backfill.py' > /tmp/usdchf_backfill.log 2>&1 &

# Watch USDCHF backfill progress
tail -f /tmp/usdchf_backfill.log
```

---

## Local Development

```bash
# Start all services with hot reload
doppler run -- docker compose -f docker-compose.yml -f docker-compose.dev.yml up

# Run backend tests (requires Docker — deps not installed locally)
docker run --rm --user root \
  -v "C:/Projects/forex-ai-platform/backend:/app" \
  -e DATABASE_URL=postgresql://dummy:dummy@localhost/dummy \
  -e REDIS_URL=redis://localhost:6379/0 \
  -e JWT_SECRET=test -e CLAUDE_API_KEY=test -e VOYAGE_API_KEY=test \
  -e OANDA_API_KEY=test -e OANDA_ACCOUNT_ID=test -e OPERATOR_PASSWORD=test \
  -e NUMBA_CACHE_DIR=/tmp/numba_cache -e PYTHONDONTWRITEBYTECODE=1 \
  forex-ai-test python -m pytest tests/ -v -p no:cacheprovider
# Build test image first if needed: docker build -t forex-ai-test ./backend

# Regenerate golden fixture (only after intentional engine changes)
cd backend && python tests/fixtures/generate_golden.py

# Backfill locally (dry run)
DRY_RUN=1 doppler run -- python backend/scripts/backfill.py
```

---

## GitHub Secrets

| Secret | Status |
|---|---|
| `GHCR_TOKEN` | ✅ Set |
| `STAGING_HOST` | ✅ Set |
| `STAGING_SSH_KEY` | ✅ Set |
| `PRODUCTION_HOST` | ⚠️ Set but points to non-existent server — needed for Phase 5 only |
| `PRODUCTION_SSH_KEY` | ⚠️ Set but points to non-existent server — needed for Phase 5 only |

---

## Code Quality Pass (2026-04-10)

Addressed six issues identified in a codebase review. All 80 tests pass.

| Fix | Files changed |
|---|---|
| **JPY pip size** — `fixed_pips` stops used `pip_size=0.0001` for all pairs; JPY pairs need `0.01` (100× difference caused immediate stop-outs on USDJPY/GBPJPY) | `engine/parser.py`, `engine/runner.py` |
| **Per-pair spread fees** — flat `7e-5` fee replaced with per-pair lookup (`_PAIR_FEES` dict); GBPJPY now correctly uses `1.7e-4` vs EURUSD's `6.5e-5` | `engine/runner.py` |
| **RAG score threshold** — chunks appearing in only one retrieval path (score ≤ 0.016) are now filtered out (`_MIN_RRF_SCORE=0.020`); reduces irrelevant context injected into Claude | `ai/retrieval.py` |
| **RAG chunk size cap** — each chunk truncated to 600 chars before injection (`_MAX_CHUNK_CHARS`) to bound worst-case API cost | `routers/copilot.py` |
| **ClickHouse removed** — service was writing data but never reading it; removed service, volume, env vars, `clickhouse.py`, `clickhouse-connect` dep, Celery startup hook | `docker-compose.yml`, `core/config.py`, `core/celery_app.py`, `tasks/backtest.py`, `requirements.txt` |
| **SQL equity curve** — Python loop replaced with `SUM/MAX OVER` window function CTE; computation now happens in TimescaleDB | `routers/analytics.py` |

Golden fixture regenerated to reflect updated EURUSD fee (`7e-5` → `6.5e-5`): Sharpe −7.5997, PnL −$327.91.

Test count: **80 passed** (up from 58 at Phase 1 gate).

---

## Post-Phase-3 Bug Fixes (2026-04-10)

| PR | Fix |
|---|---|
| #26 | Cast NUMERIC→float in `GET /api/backtest/results` (list endpoint) |
| #27 | Add `Authorization` header to Co-Pilot chat and strategy save fetches |
| #28 | Add auth guard + 401 redirect on Co-Pilot page |
| #29 | Fix `IndeterminateDatatypeError` in RAG retrieval — split shared params per query |
| #30 | Add USDCHF as sixth trading pair (backfill script + frontend) |
| #31 | Rotate Anthropic API key (GitHub secret updated) |
| #32 | Cast NUMERIC→float in `GET /api/backtest/results/{id}` (detail endpoint) ✅ merged |
| #33 | Strategy names in backtest dropdown; `Authorization` header on Strategies page; Co-Pilot save pre-fills description from `metadata.description`; Claude system prompt updated to always emit `metadata.description` in SIR ✅ merged |
| #34 | Global `AuthGuard` in root layout — suppresses render until token check completes ✅ merged |
| #35 | Synchronous auth redirect — check runs in `useState` initializer before first paint; unauthenticated users land on `/login` immediately with no blank flash ✅ merged |

---

## UI Enhancements (2026-04-11)

| PR | Change |
|---|---|
| #36 | STATUS.md update for 2026-04-10 session ✅ merged |
| #37 | Strategy delete/restore — trash bin icon, soft-delete, Active/Deleted tab toggle, restore button ✅ merged |
| #38 | STATUS.md update for 2026-04-11 session ✅ merged |
| #39 | Silent JWT token refresh — `fetchWithAuth` auto-refreshes expired tokens; no manual re-login required ✅ merged |
| #40 | Strategy detail page — backtest history table, View IR toggle, "Refine" button → Co-Pilot pre-fill, candlestick chart ✅ merged |

### Strategy delete/restore design (PR #37)

- **Soft-delete**: `DELETE /api/strategies/{id}` sets `deleted_at = NOW()` — row is never removed
- **RAG preserved**: deleted strategies remain in retrieval; labelled `[STRATEGY DELETED BY USER]` so the Co-Pilot learns which approaches were rejected and avoids reproposing them
- **UI**: Strategies page has Active / Deleted tab toggle with counts; deleted cards are dimmed with a Restore button
- **Restore**: `POST /api/strategies/{id}/restore` clears `deleted_at`; card moves back to Active tab instantly
- **Backtest dropdown**: fetches from `GET /api/strategies` (filters `deleted_at IS NULL`) and re-fetches on tab visibility change — always in sync
- **Migration**: `db/migrations/010_strategies_soft_delete.sql` — `ALTER TABLE strategies ADD COLUMN deleted_at TIMESTAMPTZ`

---

## Backtest Results Chart — Indicator Overlays (2026-04-11)

PRs #41–#48 added indicator visualisation to the backtest results page.

| PR | Change |
|---|---|
| #41 | `GET /api/analytics/backtest/{id}/indicators` endpoint + frontend overlay/oscillator rendering ✅ merged |
| #42 | Fix: `DATE` columns from asyncpg return `datetime.date` — convert to UTC-aware `datetime` before pandas comparison ✅ merged |
| #43 | Fix: wrap per-indicator computation in try/except with logging; fix bare f-strings (ruff F541) ✅ merged |
| #44 | Fix: switch DataFrame index from `pd.DatetimeIndex` to integer Unix timestamps — eliminates tz-aware comparison errors ✅ merged |
| #45 | Fix: wrap entire DB phase in try/except; surface exception class + message in response body for browser debugging ✅ merged |
| #46 | Fix: compute 300-hour warmup offset in Python (`timedelta`) instead of SQL `INTERVAL` arithmetic — resolves `UndefinedFunctionError: operator does not exist: timestamp with time zone >= interval` ✅ merged |
| #47 | Debug: log oscillator count + ref availability in chart effect (diagnostic, now superseded) ✅ merged |
| #48 | feat: synchronized crosshair across main chart and all oscillator panes ✅ merged |

### Indicator overlay design

**Backend** (`GET /api/analytics/backtest/{run_id}/indicators`):
- Joins `backtest_runs` → `strategies` to get the strategy IR
- Fetches 1H OHLCV with 300-bar warmup window (so indicators are fully primed at period start)
- Parses `entry_conditions` + ATR exit conditions from IR to build a deduplicated `specs` dict
- Computes all 8 indicators using `engine/indicators.py` functions
- Returns `{ indicators: [{ id, type, pane, levels?, series: [{name, color, data:[{time,value}]}] }] }`
- `pane: "overlay"` → EMA, SMA, BB (render on price chart); `pane: "oscillator"` → RSI, MACD, ATR, ADX, STOCH (separate panes)

**Root cause chain** (all fixed):
1. `pd.DatetimeIndex` comparison TypeError (tz-aware vs tz-naive) → switched to integer Unix timestamps
2. `DATE` asyncpg return type vs `datetime.datetime` in pandas → `_to_dt()` conversion helper
3. SQL `INTERVAL` arithmetic in `$2 - INTERVAL '300 hours'` → PostgreSQL can't infer `$2` type, returns interval; fixed by computing `ps_dt - timedelta(hours=300)` in Python

**Frontend** (`backtest/results/[id]/page.tsx`):
- `Promise.all` fetches candles + indicators in parallel; single React re-render sets both
- Chart `useEffect` (deps: `[candles, result, indicatorData]`):
  - Overlay groups: `chart.addLineSeries()` on the main candlestick chart
  - Oscillator groups: separate `createChart()` per group in `oscContainerRefs` divs below the main chart
  - Time-scale sync: `subscribeVisibleLogicalRangeChange` with `syncing` guard (pan/zoom synced)
  - Crosshair sync: `subscribeCrosshairMove` + `setCrosshairPosition(actualValue, time, series)` with `crosshairSyncing` guard — horizontal crosshair snaps to the actual indicator value at each time

### Key lessons (PRs #41–#48)
- asyncpg `DATE` columns return `datetime.date`, not `datetime.datetime` — must convert before any UTC-aware pandas operation
- SQL `$N - INTERVAL 'X hours'` fails when PostgreSQL can't infer `$N` type — always compute timestamp arithmetic in Python
- FastAPI swallows unhandled exceptions as opaque 500s with no body — wrap every code path in try/except with `logger.error(..., exc_info=True)` and return a diagnostic error field in the response for browser-side debugging
- `pd.DatetimeIndex` with tz-aware asyncpg datetimes causes subtle comparison failures — use integer Unix timestamps as the DataFrame index and compare integers throughout
- TypeScript callback parameter annotations (e.g. `(d: { indicators: unknown[] })`) override the inferred type of the variable; downstream `setState` calls receive the narrower type, causing type errors

---

## Open Items

| Item | Priority | Notes |
|---|---|---|
| Remove debug console.log from `page.tsx` | Low | `[chart] oscillators:` log from PR #47 still present — can be cleaned up |
| Phase 4 — Live Trading | Next | All 6 pairs have full data. Ready to begin. |
