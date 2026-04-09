# Forex AI Platform — Project Status

**Last updated:** 2026-04-09 (Phase 3 complete — analytics suite deployed and gate-tested)

---

## Phase Progress

| Phase | Name | Status | Gate Passed |
|---|---|---|---|
| **0** | Foundation | ✅ Complete | ✅ Health check returns 200 over HTTPS |
| **1** | Core Engine | ✅ Complete | ✅ 58 tests pass, CI green, PR #7 merged, staging live |
| **2** | AI Intelligence | ✅ Complete | ✅ Strategy created → backtest runs → results stored. AI summary pending Anthropic credits |
| **3** | Analytics Suite | ✅ Complete | ✅ 283 trades stored, equity curve 283 pts, all /api/analytics endpoints live |
| **4** | Live Trading | 🔲 Next | Pending |
| **5** | Production Launch | 🔲 Pending | Pending |

---

## Current Staging State (2026-04-09)

| Item | Value |
|---|---|
| URL | https://trading.iogga-co.com |
| Health | ✅ 200 OK |
| Services | All 9 up (nginx, fastapi, celery, nextjs, timescaledb, clickhouse, redis, prometheus, grafana) |
| Strategies in DB | 1 (Golden RSI+EMA, EURUSD 1H) |
| Backtest runs in DB | 4 |
| Trades in DB | 283 (from last gate-test run) |
| OANDA mode | `practice` (demo account, account 001-001-21125823-001) |
| `LIVE_TRADING_ENABLED` | `false` |

### OHLCV Data Coverage

| Pair | 1m | 1H | Coverage |
|---|---|---|---|
| EURUSD | ✅ 1,857,300 | ✅ 31,134 | Apr 2021 – Apr 2026 |
| GBPUSD | ✅ 1,857,406 | ✅ 31,143 | Apr 2021 – Apr 2026 |
| USDJPY | ✅ 1,859,916 | ✅ 31,130 | Apr 2021 – Apr 2026 |
| EURGBP | ✅ 1,854,281 | 🔄 downloading | 1m: Apr 2021–Apr 2026; 1H: in progress |
| GBPJPY | ❌ | ❌ | Queued after EURGBP 1H |

---

## Phase 0 — Foundation ✅

**Gate passed 2026-04-05.**

### Deliverables
- GitHub repo with branch protection — CI must pass before merge (6 jobs)
- Docker Compose — 9 services: nginx, fastapi, celery, nextjs, timescaledb, clickhouse, redis, prometheus, grafana
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
- `backend/core/clickhouse.py` — ClickHouse client; `backtest_metrics` + `backtest_trades` ReplacingMergeTree tables; `write_backtest_run()` called best-effort after PostgreSQL insert; `init_schema()` called at Celery `worker_ready`
- `backend/routers/analytics.py` — `GET /api/analytics/backtest/{id}/equity-curve` (cumulative PnL + drawdown series), `GET /api/analytics/backtest/{id}/export-csv` (trades CSV), `GET /api/analytics/strategies/compare` (multi-strategy aggregation)
- `backend/tests/test_analytics.py` — 9 tests: equity math, ClickHouse failure tolerance, async mock endpoint tests
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

# Resume backfill (run inside fastapi container)
docker exec -d forex-ai-platform-fastapi-1 bash -c \
  'BACKFILL_PAIRS=EURGBP BACKFILL_TIMEFRAMES=1H python /app/scripts/backfill.py > /tmp/backfill_eurgbp_1h.log 2>&1'
docker exec -d forex-ai-platform-fastapi-1 bash -c \
  'BACKFILL_PAIRS=GBPJPY python /app/scripts/backfill.py > /tmp/backfill_gbpjpy.log 2>&1'
```

---

## Local Development

```bash
# Start all services with hot reload
doppler run -- docker compose -f docker-compose.yml -f docker-compose.dev.yml up

# Run backend tests
cd backend && pytest tests/ -v

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

## Open Items (non-blocking)

| Item | Priority | Notes |
|---|---|---|
| Anthropic credits | Medium | AI auto-summary implemented but returns 400 credit error. Top up at console.anthropic.com → Plans & Billing |
| EURGBP 1H backfill | Low | In progress on staging. Re-run if interrupted: see backfill commands above |
| GBPJPY 1m + 1H backfill | Low | Start after EURGBP 1H completes |
| Frontend backtest page | Medium | Current `/backtest` is a placeholder stub — backtest must be submitted via API directly. Full form was built but replaced; needs reinstatement in Phase 4 sprint |
