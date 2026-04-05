# Forex AI Platform — Project Status

**Last updated:** 2026-04-05 (CI secrets corrected — STAGING_SSH_KEY and STAGING_HOST verified)

---

## Phase Progress

| Phase | Name | Status | Gate Passed |
|---|---|---|---|
| **0** | Foundation | ✅ Complete | ✅ Health check returns 200 over HTTPS |
| **1** | Core Engine | Not started | Pending |
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
| `PRODUCTION_HOST` | Not set — needed for Phase 5 |
| `PRODUCTION_SSH_KEY` | Not set — needed for Phase 5 |

---

## Phase 1 — What comes next

**Goal:** One complete backtest runs end-to-end with correct metrics.

**Deliverables:**
- Dukascopy historical data downloader (tick → OHLCV → TimescaleDB)
- yfinance daily data ingest
- Strategy IR parser
- Indicator library (RSI, EMA, SMA, MACD, Bollinger Bands, ATR, ADX, Stochastic)
- vectorbt portfolio runner with stop-loss/take-profit
- Golden dataset regression tests
- Celery backtest job with WebSocket progress streaming
- FastAPI backtest endpoint (`POST /api/backtest`)
