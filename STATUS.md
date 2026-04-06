# Forex AI Platform — Project Status

**Last updated:** 2026-04-06 (Phase 1 complete — all CI green, staging deployed)

---

## Phase Progress

| Phase | Name | Status | Gate Passed |
|---|---|---|---|
| **0** | Foundation | ✅ Complete | ✅ Health check returns 200 over HTTPS |
| **1** | Core Engine | ✅ Complete | ✅ 58 tests pass, CI green, PR #7 merged, staging live |
| **2** | AI Intelligence | Not started | Pending |
| **3** | Analytics Suite | Not started | Pending |
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
| `backtest_runs` | Backtest results with metrics |
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

## Phase 2 — Next: AI Intelligence

**Goal:** AI Co-Pilot produces a valid SIR from natural language, stored in RAG, retrievable by subsequent queries.

### What to build
- Claude API integration — system prompt with SIR schema, indicator descriptions, risk rules
- Voyage AI embedding service — wraps Voyage AI API, caches in Redis
- pgvector + BM25 hybrid retrieval — `conversation_turns`, `strategies`, `backtest_runs`
- Auto-summary pipeline — Claude summarises each backtest result, stored with embedding
- Conversation endpoint — embed → retrieve → assemble prompt → stream response
- SIR editor — parse Claude's proposed SIR update, validate, diff, store new version
- Co-Pilot frontend panel — chat history + Strategy IR inspector with version history

### Before starting Phase 2 (optional but recommended)
Run the backfill script on staging to load 5yr historical data (~2h, idempotent):
```bash
ssh deploy@86.48.16.255 "cd /opt/forex-ai-platform && doppler run -- python backend/scripts/backfill.py"
```

Then seed a test strategy and run an E2E backtest to confirm the full stack on real data:
```bash
# 1. Create a test strategy
curl -X POST https://trading.iogga-co.com/api/strategies \
  -H "Authorization: Bearer <jwt>" \
  -H "Content-Type: application/json" \
  -d @backend/tests/fixtures/golden_strategy.json

# 2. Run a backtest (replace strategy_id and session_id)
curl -X POST "https://trading.iogga-co.com/api/backtest?session_id=test123" \
  -H "Authorization: Bearer <jwt>" \
  -H "Content-Type: application/json" \
  -d '{"strategy_id":"<uuid>","period_start":"2020-01-01","period_end":"2024-01-01","pair":"EURUSD","timeframe":"1H"}'
```

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
# Check service status
ssh deploy@86.48.16.255 "cd /opt/forex-ai-platform && doppler run -- docker compose ps"

# View logs
ssh deploy@86.48.16.255 "cd /opt/forex-ai-platform && doppler run -- docker compose logs fastapi --tail=50"

# Health check
curl https://trading.iogga-co.com/api/health
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
