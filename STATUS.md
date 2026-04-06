# Forex AI Platform — Project Status

**Last updated:** 2026-04-06 (Phase 1 in progress — all Phase 1 code written, pending golden fixture generation and staging deploy)

---

## Phase Progress

| Phase | Name | Status | Gate Passed |
|---|---|---|---|
| **0** | Foundation | ✅ Complete | ✅ Health check returns 200 over HTTPS |
| **1** | Core Engine | 🔄 In Progress | Pending: generate golden fixtures, run CI, verify E2E backtest |
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
| `ohlcv_candles` | TimescaleDB hypertable for price data (Phase 1) |
| `strategies` | Strategy IR versions with embeddings (Phase 2) |
| `conversation_turns` | Full dialog history with BM25 + vector indexes (Phase 2) |
| `backtest_runs` | Backtest results with Claude-generated summaries (Phase 1/2) |
| `trades` | Per-trade granularity with MAE/MFE (Phase 1) |
| `live_orders` | Live execution record (Phase 4) |
| `alert_events` | System-wide monitoring event log (all phases) |

---

## Phase 1 — In Progress

**Goal:** One complete backtest runs end-to-end with correct metrics.

### Code written (2026-04-06)

**New packages added to requirements.txt:**
- `numpy==1.26.4`, `pandas==2.2.3`, `vectorbt==0.26.2`
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
- `backend/tasks/backtest.py` — full Celery task implementation (fetch → run → store → publish)
- `backend/core/celery_app.py` — updated: include=["tasks.backtest"]
- `backend/routers/backtest.py` — POST /api/backtest, GET /api/backtest/jobs/{id}/status, GET /api/backtest/results/{id}
- `backend/routers/strategy.py` — implemented: POST, GET list, GET by ID

**Tests:**
- `backend/tests/conftest.py` — shared fixtures: synthetic OHLCV, SIR dicts, golden dataset
- `backend/tests/test_indicators.py` — unit tests for all 8 indicators
- `backend/tests/test_sir_parser.py` — SIR validation and SIRParser unit tests
- `backend/tests/test_golden.py` — golden dataset regression tests (skip if fixture not generated)
- `backend/tests/fixtures/golden_strategy.json` — the golden strategy definition
- `backend/tests/fixtures/generate_golden.py` — script to generate golden_expected.json

**Scripts:**
- `backend/scripts/backfill.py` — CLI script to backfill 5yr historical data from Dukascopy

### Remaining before Phase 1 gate

- [ ] **Generate golden fixtures**: `cd backend && python tests/fixtures/generate_golden.py`
  (requires all packages installed; run locally or in dev Docker container)
- [ ] **Run full test suite**: `pytest backend/tests/ -v` — all tests must pass
- [ ] **Backfill historical data**: `doppler run -- python backend/scripts/backfill.py`
  (downloads 5yr EURUSD/GBPUSD/USDJPY/EURGBP/GBPJPY 1m+1H — takes ~2 hours)
- [ ] **Create test strategy**: POST to `/api/strategies` with a SIR document
- [ ] **Run E2E backtest**: POST to `/api/backtest`, verify WebSocket progress, GET result
- [ ] **Verify gate criteria**: complete backtest on 4yr EUR/USD 1H, output matches expected metrics
- [ ] CI pipeline green on the Phase 1 feature branch
- [ ] Merge to main and confirm staging deploy

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

### Running services
```
doppler run -- docker compose ps   # check status
doppler run -- docker compose logs <service> --tail=50   # check logs
```

---

## Local Development

```bash
# Start all services with hot reload
doppler run -- docker compose -f docker-compose.yml -f docker-compose.dev.yml up

# Start without hot reload (matches server behaviour)
doppler run -- docker compose up
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
