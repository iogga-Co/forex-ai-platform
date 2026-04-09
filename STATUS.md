# Forex AI Platform — Project Status

**Last updated:** 2026-04-09 (Phase 3 complete — analytics suite deployed, gate test passed)

---

## Phase Progress

| Phase | Name | Status | Gate Passed |
|---|---|---|---|
| **0** | Foundation | ✅ Complete | ✅ Health check returns 200 over HTTPS |
| **1** | Core Engine | ✅ Complete | ✅ 58 tests pass, CI green, PR #7 merged, staging live |
| **2** | AI Intelligence | ✅ Complete | ✅ Strategy created → backtest runs → results stored. AI summary pending Anthropic credits |
| **3** | Analytics Suite | ✅ Complete | ✅ 283 trades, 283 equity curve points, /api/analytics endpoints live |
| **4** | Live Trading | Not started | Pending |
| **5** | Production Launch | Not started | Pending |

---

## Phase 0 — Deliverables

### Infrastructure
- [x] GitHub repo with branch protection on `main` — CI must pass before merge
- [x] GitHub Actions CI — 6 jobs: lint, type check, unit tests, Docker build, integration tests, staging deploy
- [x] Docker Compose — all 9 services: nginx, fastapi, celery, nextjs, timescaledb, clickhouse, redis, prometheus, grafana
- [x] Doppler secrets management — `development` and `staging` configs active
- [x] Staging VPS provisioned (Contabo, Ubuntu 24.04, 86.48.16.255)
- [x] UFW firewall — only ports 22, 80, 443 open
- [x] SSL certificate via Let's Encrypt — `trading.iogga-co.com`, expires 2026-07-04, auto-renewing
- [x] Nginx — SSL termination, HTTP→HTTPS redirect, rate limiting (100 req/min), WebSocket upgrade

### Application Skeleton
- [x] FastAPI — route structure, JWT auth middleware, health check at `/api/health`, WebSocket hub
- [x] Next.js 15 — TypeScript, Tailwind CSS, 5 routes: dashboard, backtest, strategies, copilot, live
- [x] Database migrations — all 7 tables with indexes, pgvector, TimescaleDB hypertable

### Tables created
| Table | Purpose |
|---|---|
| `ohlcv_candles` | TimescaleDB hypertable for price data |
| `strategies` | Strategy IR versions with embeddings |
| `conversation_turns` | Full dialog history with BM25 + vector indexes |
| `backtest_runs` | Backtest results with metrics, summary_text, embedding |
| `trades` | Per-trade granularity with MAE/MFE |
| `live_orders` | Live execution record |
| `alert_events` | System-wide monitoring event log |

---

## Phase 1 — Complete ✅

**Gate passed 2026-04-06.** PR #7 merged to main. All 6 CI jobs green. Staging auto-deployed.

### What was built

**New packages:**
- `numpy==1.26.4`, `pandas==2.2.3`, `vectorbt==0.26.2`, `plotly==5.11.0`
- `yfinance==0.2.51`, `psycopg2-binary==2.9.10`, `pytest-mock==3.14.0`

**New DB migration:**
- `db/migrations/009_backtest_runs_task_id.sql` — adds `celery_task_id` for idempotent task retries

**Infrastructure:**
- `backend/core/db.py` — asyncpg connection pool for FastAPI
- `backend/core/redis_bridge.py` — Redis pub/sub bridge: Celery → WebSocket progress streaming
- `backend/main.py` — updated lifespan: DB pool init + Redis bridge background task

**Data pipeline:**
- `backend/data/models.py` — OHLCVBar Pydantic model (UTC-aware, float64, high≥low validation)
- `backend/data/quality.py` — UTC normalisation, gap detection, outlier filtering (z-score)
- `backend/data/db.py` — psycopg2 sync helpers: bulk_insert_candles, fetch_candles, insert_backtest_run, bulk_insert_trades
- `backend/data/dukascopy.py` — Dukascopy HTTP downloader: LZMA .bi5 decompression, tick→OHLCV resample
- `backend/data/yfinance_ingest.py` — yfinance daily data ingest

**Backtesting engine:**
- `backend/engine/sir.py` — StrategyIR Pydantic model with full validation
- `backend/engine/indicators.py` — RSI, EMA, SMA, MACD, Bollinger Bands, ATR, ADX, Stochastic (TradingView-compatible)
- `backend/engine/filters.py` — London/NY/Asian session filters + day-of-week exclusions
- `backend/engine/sizing.py` — ATR-based position sizing
- `backend/engine/parser.py` — SIRParser: SIR → signal arrays, stop fractions, filter mask
- `backend/engine/metrics.py` — extract metrics + per-trade records from vectorbt portfolio
- `backend/engine/runner.py` — vectorbt portfolio runner with look-ahead bias prevention

**Celery & API:**
- `backend/tasks/backtest.py` — full Celery task: fetch → validate → run → store → publish
- `backend/core/celery_app.py` — updated: `include=["tasks.backtest"]`
- `backend/routers/backtest.py` — POST /api/backtest, GET /api/backtest/jobs/{id}/status, GET /api/backtest/results/{id}
- `backend/routers/strategy.py` — POST, GET list, GET by ID

**Tests (58 total, all passing):**
- `backend/tests/conftest.py` — shared fixtures: synthetic OHLCV, SIR dicts, golden dataset
- `backend/tests/test_indicators.py` — 38 unit tests for all 8 indicators
- `backend/tests/test_sir_parser.py` — 12 SIR validation and SIRParser unit tests
- `backend/tests/test_golden.py` — 7 golden dataset regression tests
- `backend/tests/test_health.py` — 3 health check tests
- `backend/tests/fixtures/golden_strategy.json` — the golden strategy definition
- `backend/tests/fixtures/golden_expected.json` — pre-computed reference output (committed)
- `backend/tests/fixtures/generate_golden.py` — script to regenerate golden_expected.json

**Scripts:**
- `backend/scripts/backfill.py` — CLI script to backfill 5yr historical data from Dukascopy

### Key lessons from Phase 1
- `backend/data/` was silently excluded by `.gitignore`'s `data/` pattern — fixed with `!backend/data/` exception
- `vectorbt==0.26.2` requires `numpy==1.26.4` (<2.0) and `plotly==5.11.0` (heatmapgl removed in ≥5.12)
- `NUMBA_CACHE_DIR=/tmp/numba_cache` required when running vectorbt in Docker as non-root
- CI pytest needs `working-directory: backend` + `PYTHONPATH: ${{ github.workspace }}/backend`

---

## Phase 2 — Complete ✅

**Gate passed 2026-04-09.** PRs #10–#18 merged. Staging deployed and smoke test passing.
Strategy creation → backtest execution → results stored confirmed end-to-end.
AI auto-summary is implemented but currently blocked by Anthropic API credit balance.

### What was built

**New packages:**
- `anthropic==0.49.0` — Claude API client with streaming support
- `voyageai==0.2.4` — Voyage AI embedding client
- `pytest-asyncio==0.24.0` — async test support

**New DB migration (applied manually — was not in initial schema):**
- `db/migrations/009_backtest_runs_task_id.sql` — applied to staging via `psql` directly

**AI layer:**
- `backend/ai/__init__.py` — package init
- `backend/ai/claude_client.py` — Anthropic streaming client; `stream_chat()`, `extract_sir_from_response()`, `summarize_backtest()`; uses ` ```sir ` fenced block format for SIR proposals
- `backend/ai/voyage_client.py` — Voyage AI 1024-dim embeddings with Redis cache (TTL=7d)
- `backend/ai/retrieval.py` — hybrid RAG: pgvector cosine similarity + BM25 full-text, fused with RRF (`_TOP_N=6`, `_RRF_K=60`)

**API:**
- `backend/routers/copilot.py` — `POST /api/copilot/chat` (SSE stream: `text`/`sir`/`error`/`done` events), `GET /api/copilot/sessions/{id}`
- `backend/main.py` — registered copilot router

**Config:**
- `backend/core/config.py` — added `operator_password: str` field to Settings

**Celery:**
- `backend/tasks/backtest.py` — added `_generate_and_store_summary()`: auto-summarises with Claude, embeds with Voyage, stores `summary_text` + `embedding` on `backtest_runs` (best-effort, non-fatal)

**Frontend:**
- `frontend/src/app/copilot/page.tsx` — split-view chat + SIR inspector; streaming SSE parser; Save Strategy form; New Session button
- `frontend/src/app/strategies/page.tsx` — strategies list with expandable IR viewer, Backtest link, loading skeletons, empty state

**Tests (11 new, all passing):**
- `backend/tests/test_copilot.py` — SIR extraction (4 tests), RRF fusion (3 tests), Voyage cache hit/miss (2 tests), summarisation (1 test), router 404 (1 test)

**Infrastructure fixes (PRs #11–#18):**
- `NUMBA_CACHE_DIR=/tmp/numba_cache` added to fastapi + celery services
- `OPERATOR_PASSWORD` added to fastapi + celery services
- `PYTHONPATH=/app` added to celery service (ForkPoolWorker changes working directory)
- CI deploy: `docker compose pull` → `docker compose build fastapi celery nextjs`
- CI deploy: added `nginx -s reload` after `docker compose up` to flush stale upstream IPs
- CI smoke test: replaced flat `sleep 30` with retry loop (12 × 15s = 3 min max)

### Key lessons from Phase 2
- Celery `ForkPoolWorker` changes working directory — lazy imports fail without `PYTHONPATH=/app`
- Nginx caches upstream IPs at startup — must run `nginx -s reload` after container rebuilds or `proxy_pass` returns 502
- `voyageai` latest version is `0.2.4`, not `0.3.x` — pin explicitly
- Mypy: Redis `get()`/`mget()` return `Awaitable[Any] | Any` — requires `cast(str | None, ...)`
- Anthropic SDK: use `MessageParam` from `anthropic.types` for typed message lists
- TimescaleDB `initdb` migrations only run on a fresh volume — new migration files must be applied manually with `psql` on existing staging DB
- Contabo VPS has a network-level firewall separate from `ufw` — both must allow port 22

### Data backfill status (as of 2026-04-09)
| Pair | 1m | 1H | Coverage |
|---|---|---|---|
| EURUSD | ✅ 1.86M candles | ✅ 31K candles | Apr 2021 – Apr 2026 |
| GBPUSD | ✅ 1.86M candles | ✅ 31K candles | Apr 2021 – Apr 2026 |
| USDJPY | ✅ 1.86M candles | ✅ 31K candles | Apr 2021 – Apr 2026 |
| EURGBP | ✅ 1.85M candles | 🔄 in progress | 1m complete; 1H ~Sep 2025 |
| GBPJPY | ❌ pending | ❌ pending | Queued after EURGBP |

---

## Phase 3 — Complete ✅

**Gate passed 2026-04-09.** PRs #20–#22 merged. Staging deployed. Gate test: 283 trades stored, equity curve returns 283 points with correct PnL/drawdown series.

### What was built

**Backend:**
- `backend/core/clickhouse.py` — ClickHouse client with `backtest_metrics` + `backtest_trades` ReplacingMergeTree tables; `write_backtest_run()` called best-effort after PostgreSQL insert
- `backend/routers/analytics.py` — three endpoints: equity curve (`/backtest/{id}/equity-curve`), CSV export, strategy comparison
- `backend/tasks/backtest.py` — ClickHouse ETL hook after DB insert
- `backend/main.py` — analytics router registered
- `backend/tests/test_analytics.py` — 9 tests covering equity math, ClickHouse failure tolerance, endpoint 404/200

**Grafana:**
- `grafana/provisioning/` — Prometheus datasource + dashboard file provider
- `grafana/dashboards/system.json` — HTTP rate, p95 latency, error rate, Celery tasks
- `grafana/dashboards/backtests.json` — backtest throughput, endpoint latency, copilot calls

**Key fixes during Phase 3:**
- asyncpg 0.30 returns `jsonb` as raw strings by default — registered json/jsonb type codecs on pool init (fixed 500 on GET /api/strategies)
- `vectorbt.trades.records_readable` Entry/Exit Index timestamps fail `df.index.get_loc()` due to timezone round-trip — switched to `records.iloc[i]["entry_idx"]` integer positions (fixed all trades silently skipped)
- ClickHouse `init_schema()` was never called — added `worker_ready` signal in `celery_app.py`
- Frontend `useRef` missing from React imports (CI TypeScript error)
- `package-lock.json` not regenerated after adding recharts (CI npm ci error)

### Data backfill status (as of 2026-04-09)
| Pair | 1m | 1H | Coverage |
|---|---|---|---|
| EURUSD | ✅ 1.86M candles | ✅ 31K candles | Apr 2021 – Apr 2026 |
| GBPUSD | ✅ 1.86M candles | ✅ 31K candles | Apr 2021 – Apr 2026 |
| USDJPY | ✅ 1.86M candles | ✅ 31K candles | Apr 2021 – Apr 2026 |
| EURGBP | ✅ 1.85M candles | 🔄 in progress | 1m complete; 1H downloading |
| GBPJPY | ❌ pending | ❌ pending | Queued after EURGBP 1H |

---

## Phase 4 — Live Trading

**Goal:** Paper → live order execution via OANDA. Single feature flag (`LIVE_TRADING_ENABLED`) controls the switch.

### What to build
- OANDA streaming price feed — replace Redis mock with real tick data
- Order execution engine — translate SIR signals to OANDA market/limit orders
- Live position monitor — WebSocket feed to frontend, P&L in real time
- Kill switch — operator endpoint to flatten all positions immediately
- Live trading page — position table, open orders, equity ticker

### Gate test
Place a paper trade on OANDA practice account and confirm order appears in the live trading page.

---

## Phase 5 — Production Launch

**Goal:** Harden, monitor, and cut over to production VPS with real money disabled by default.

### What to build
- Production VPS provisioning (separate server from staging)
- Grafana alerting — latency, error rate, drawdown breach
- Log aggregation — structured JSON logs shipped to persistent storage
- `LIVE_TRADING_ENABLED` operator runbook — step-by-step checklist before enabling real money
- Load test — confirm system handles 100 concurrent WebSocket connections

### Gate test
Production smoke test passes. Grafana dashboard shows all green. Runbook reviewed.

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
| OANDA mode | `practice` (demo account) |

### Useful commands
```bash
# SSH (specify key explicitly — Contabo network firewall may block unknown IPs)
ssh -i ~/.ssh/forex-ai-deploy -o IdentitiesOnly=yes deploy@trading.iogga-co.com

# Check service status
ssh -i ~/.ssh/forex-ai-deploy -o IdentitiesOnly=yes deploy@trading.iogga-co.com \
  "cd /opt/forex-ai-platform && docker compose ps"

# View logs
ssh -i ~/.ssh/forex-ai-deploy -o IdentitiesOnly=yes deploy@trading.iogga-co.com \
  "docker compose -f /opt/forex-ai-platform/docker-compose.yml logs fastapi --tail=50"

# Health check
curl https://trading.iogga-co.com/api/health

# Check backfill progress
ssh -i ~/.ssh/forex-ai-deploy -o IdentitiesOnly=yes deploy@trading.iogga-co.com \
  "docker exec forex-ai-platform-fastapi-1 tail -f /tmp/backfill.log"
```

---

## Local Development

```bash
# Start all services with hot reload
doppler run -- docker compose -f docker-compose.yml -f docker-compose.dev.yml up

# Run tests (from repo root)
cd backend && pytest tests/ -v

# Run backfill locally (dry run)
DRY_RUN=1 doppler run -- python backend/scripts/backfill.py
```

---

## GitHub Secrets Required

| Secret | Status |
|---|---|
| `GHCR_TOKEN` | ✅ Set |
| `STAGING_HOST` | ✅ Set |
| `STAGING_SSH_KEY` | ✅ Set |
| `PRODUCTION_HOST` | ⚠️ Set but points to non-existent server — needed for Phase 5 only |
| `PRODUCTION_SSH_KEY` | ⚠️ Set but points to non-existent server — needed for Phase 5 only |
