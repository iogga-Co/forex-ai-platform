# Forex AI Trading Platform — Implementation Roadmap

**Version:** 1.0
**Date:** April 2026
**Scope:** Development, Deployment & Operations Guide

---

## Table of Contents

1. [Development Philosophy](#1-development-philosophy)
2. [Phase Overview](#2-phase-overview)
3. [Detailed Phase Breakdown](#3-detailed-phase-breakdown)
   - 3.1 [Phase 0 — Foundation](#phase-0--foundation-week-1-2)
   - 3.2 [Phase 1 — Core Engine](#phase-1--core-engine-week-2-4)
   - 3.3 [Phase 2 — AI Intelligence](#phase-2--ai-intelligence-week-4-6)
   - 3.4 [Phase 3 — Analytics Suite](#phase-3--analytics-suite-week-6-8)
   - 3.5 [Phase 4 — Live Trading](#phase-4--live-trading-week-8-10)
   - 3.6 [Phase 5 — Production Launch](#phase-5--production-launch-week-10)
4. [Git Strategy & Testing](#4-git-strategy--testing)
5. [CI/CD Pipeline](#5-cicd-pipeline)
6. [Deployment Architecture](#6-deployment-architecture)
7. [Observability & Alerting](#7-observability--alerting)
8. [Pre-Production Security Checklist](#8-pre-production-security-checklist)

---

## 1. Development Philosophy

The system is built solo, which means the methodology must minimize ceremony while maximizing safety. The chosen approach is **Kanban with clearly defined phase gates**: a continuous flow of work, but with hard checkpoints before activating each new subsystem. No new phase begins until the previous one is validated.

The phase gate model is especially important for a trading system because the cost of a bug scales with proximity to live capital. A bug in the indicator calculation engine costs debugging time. A bug in the live order execution engine costs money. The gates enforce a discipline of verification before progression.

Four rules govern development throughout all phases:

1. **Nothing goes to production without passing CI.** No exceptions.
2. **The live trading engine is never enabled automatically.** Every activation requires a deliberate operator action.
3. **Every strategy, backtest result, and conversation is kept permanently.** Nothing is deleted.
4. **Determinism is verified on every commit.** The golden dataset regression suite must always pass.

---

## 2. Phase Overview

| Phase | Name | Est. Duration | Key Deliverables | Gate Criteria |
|---|---|---|---|---|
| **0** | Foundation | Week 1–2 | Repo, CI/CD, Docker Compose, DB schemas, FastAPI skeleton, Nginx on VPS | All services start cleanly in dev and staging |
| **1** | Core Engine | Week 2–4 | Data pipeline, TimescaleDB ingestion, vectorbt backtesting, Strategy IR | One complete backtest runs end-to-end with correct metrics |
| **2** | AI Intelligence | Week 4–6 | Claude API integration, RAG pipeline, pgvector, Co-Pilot interface | AI produces valid SIR from natural language, stored in RAG |
| **3** | Analytics Suite | Week 6–8 | Full chart library, AG Grid trade table, MAE/MFE, Monte Carlo, compare | All analytics match hand-calculated values on known test data |
| **4** | Live Trading | Week 8–10 | OANDA paper trading, order manager, risk manager, kill switch, alerting | 30-day paper trading gate: zero uncaught errors |
| **5** | Production Launch | Week 10+ | Live capital enabled, observability dashboards, backup automation | Paper gate passed + all security checklist items complete |

---

## 3. Detailed Phase Breakdown

### Phase 0 — Foundation (Week 1–2)

The goal of Phase 0 is a fully working development environment and production-ready infrastructure skeleton before any domain logic is written. Starting with infrastructure prevents the painful retrofitting of CI/CD, secrets management, and containerization onto a partially-built codebase.

**Infrastructure & DevOps**

- Create GitHub repository with branch protection on `main`: no direct pushes, CI must pass before merge
- Set up GitHub Actions workflow: lint (ruff + ESLint) + type check (mypy) + unit tests + build on every push
- Configure Doppler for secrets management: create `development`, `staging`, and `production` environments
- Write Docker Compose file defining all services: FastAPI, Next.js, TimescaleDB, ClickHouse, Redis, Celery, Nginx
- Provision staging VPS (Hetzner CX31 or DigitalOcean 4GB): install Docker, configure UFW firewall, set up SSL with Let's Encrypt

**Application Skeleton**

- FastAPI: define route structure, JWT authentication middleware, health check endpoint, WebSocket hub scaffold
- Next.js: project init with TypeScript, Tailwind CSS, and route structure for all main views
- Database schemas: create all tables (`ohlcv_candles`, `strategies`, `conversation_turns`, `backtest_runs`, `trades`, `live_orders`, `alert_events`) with indexes and pgvector extension

**Gate:** All services start cleanly with `docker compose up`, health endpoints return 200, staging deploy completes without errors.

---

### Phase 1 — Core Engine (Week 2–4)

Phase 1 delivers the fundamental data and backtesting capabilities. This is the hardest phase to get right because every subsystem built later depends on the correctness of this layer.

**Data Pipeline**

- Build Dukascopy historical data downloader: fetch tick data, resample to OHLCV at configurable timeframes, normalize and insert into TimescaleDB
- Add yfinance daily data ingest for supplemental pairs
- Create data quality checks: gap detection, outlier filtering, timezone normalization to UTC
- Write backfill script to load 5+ years of EUR/USD, GBP/USD, USD/JPY, EUR/GBP, and GBP/JPY at 1m and 1H timeframes

**Backtesting Engine**

- Implement Strategy IR parser: reads the JSON SIR and resolves indicator definitions to vectorbt signal arrays
- Build the indicator library: RSI, EMA, SMA, MACD, Bollinger Bands, ATR, ADX, Stochastic — all with configurable parameters
- Implement session filters, day-of-week filters, and ATR-based position sizing from the SIR
- Wire vectorbt portfolio runner: entry/exit signals, stop-loss/take-profit as trailing or fixed levels, return full trade log
- Write **golden dataset tests**: known strategy on known EUR/USD data slice must always produce an exact, pre-verified trade list
- Expose backtest endpoint in FastAPI as a Celery background job with WebSocket progress updates

**Gate:** Run a complete backtest on 4 years of EUR/USD 1H data. Verify output matches expected metrics within tolerance. Golden dataset tests all pass.

---

### Phase 2 — AI Intelligence (Week 4–6)

Phase 2 adds the Co-Pilot and RAG layer. The goal is a working conversational strategy design interface where every interaction is stored and retrievable.

**RAG Pipeline**

- Install and configure pgvector extension; add embedding columns to `conversation_turns`, `strategies`, `backtest_runs`, and `trades` tables
- Build embedding service: wraps Voyage AI API, handles batching and retries, caches recent embeddings in Redis
- Implement BM25 index on all text fields using PostgreSQL full-text search (`tsvector`/`tsquery`)
- Build hybrid retrieval function: runs vector similarity and BM25 in parallel, merges results with re-ranking by combined score and recency
- Build the auto-summary pipeline: after each backtest, call Claude to generate a prose summary and store it with embedding in `backtest_runs`

**AI Co-Pilot Interface**

- Build system prompt for Claude: includes strategy design principles, indicator descriptions, risk management guidelines, and SIR schema
- Implement conversation endpoint: embed user message, retrieve RAG context, assemble Claude prompt with context + current SIR, stream response
- Build SIR editor: parses Claude's proposed strategy update, validates against SIR schema, diffs against previous version, stores new version
- Build Co-Pilot frontend panel: split-view with chat history on left, Strategy IR inspector with version history on right

**Gate:** AI produces a valid, parseable SIR from a plain English strategy description, stored correctly in RAG, and retrievable by subsequent queries that reference the same pair or indicators.

---

### Phase 3 — Analytics Suite (Week 6–8)

Phase 3 delivers the full visualization and analysis layer. Every analytic output must be validated against hand-calculated values on a known dataset before the phase is considered complete.

- Master Trade Table: AG Grid with all 15+ columns, filtering, sorting, grouping by session/day/direction, export to CSV and Excel
- Equity curve and drawdown chart: Plotly with synchronized time axis and click-through to filter trade table
- Monthly returns heatmap: calendar grid with color scale and click filtering by month
- Win rate by hour of day: Plotly bar chart segmented by session with hover statistics
- P&L and R-multiple distribution histograms with configurable bin width and long/short split
- MAE/MFE scatter plot: each trade as a point, colored by outcome, with click-to-trade linking
- Monte Carlo simulation: randomize trade order 1,000+ times, display percentile fan chart with adjustable simulation count
- Rolling metrics chart: 30/60/90-day rolling Sharpe, win rate, average R with adjustable window
- Streak analysis: max consecutive streaks, autocorrelation display, visual trade sequence
- Strategy version comparison table: all versions side-by-side with metric deltas highlighted
- "Ask AI about this" button on every chart, passing chart data and context to the Co-Pilot

**Gate:** All metrics for a known test dataset match pre-calculated reference values within floating point tolerance.

---

### Phase 4 — Live Trading (Week 8–10)

Phase 4 adds live order execution using OANDA's demo account first. Live capital is enabled only after the 30-day paper trading gate is passed without exception. This phase must not be rushed.

**Paper Trading Setup**

- Connect OANDA streaming API: authenticate, receive bid/ask ticks, push to Redis pub/sub channel
- Build Signal Evaluator: subscribes to Redis price feed, evaluates active SIR conditions, generates signals on bar close
- Build Order Manager: translates signals to OANDA v20 REST API orders, handles confirmation, partial fills, and rejections with retry logic
- Build Risk Manager: enforces all pre-trade checks (position size, daily loss limit, max concurrent trades) before any order reaches the Order Manager
- Implement Position Tracker: polls OANDA account state every 5 seconds, maintains Redis cache of open positions and running P&L
- Implement Kill Switch endpoint: authenticated, rate-limited, closes all positions at market and sets engine feature flag to disabled
- Run 30 consecutive days on OANDA demo account with zero uncaught exceptions, zero missed kill switch responses, and full trade logging

**Gate:** 30 days of paper trading completed on staging with zero uncaught exceptions in the trading engine and all trade logs complete.

---

### Phase 5 — Production Launch (Week 10+)

- Switch OANDA environment variable from demo to live account credentials in Doppler production environment
- Verify all Grafana dashboards show live data and all Prometheus alert rules are firing correctly on test triggers
- Confirm automated daily backup is running and a full restore has been tested on an empty server
- Complete the Pre-Production Security Checklist (Section 8) with all items verified
- Enable live trading feature flag manually in Doppler after confirming all systems nominal
- Monitor closely for the first 72 hours: review every executed trade, confirm all logs are complete

---

## 4. Git Strategy & Testing

### 4.1 Branching Model

All development uses trunk-based development with short-lived feature branches. No branch should live longer than a few days. All merges to `main` require CI to pass.

| Branch Pattern | Purpose | Merge Policy |
|---|---|---|
| `main` | Always deployable. The source of truth for staging and production. | CI must pass. Squash merge preferred. |
| `feature/*` | New features or significant additions. One feature per branch. | Merge to main within 2–3 days maximum. |
| `fix/*` | Bug fixes. Keep small and focused. | Merge to main as soon as tests pass. |
| `experiment/*` | Exploratory work not yet committed to. May never merge. | Merge only if experiment succeeds. Delete otherwise. |

The live trading engine changes are deployed via **feature flag**, not separate branches. Code can reach production in a disabled state, which is safer than a long-running branch that diverges significantly from `main`.

### 4.2 Testing Strategy

The test suite has four layers. The bottom two are unique to trading systems and are the most important.

| Layer | Scope | Tools | Example |
|---|---|---|---|
| **Golden Dataset Tests** | Fixed strategy on fixed data must always produce identical trade list and metrics | pytest, fixture files | RSI+EMA on 2022 EUR/USD 1H always produces exactly 147 trades with Sharpe 0.94 |
| **Unit Tests** | Indicator calculations, SIR parser, RAG chunker, position sizing formulas, P&L math | pytest, numpy.testing | RSI(14) on known OHLCV array matches TradingView values. ATR stop correctly sized to 1.5× ATR. |
| **Integration Tests** | API endpoints, database queries, Celery job dispatch, OANDA API responses (mocked) | pytest, httpx, respx | POST `/api/backtest` dispatches Celery job, result appears in DB, WebSocket emits progress events. |
| **E2E Tests** | Critical user flows: start backtest, view results, create strategy via Co-Pilot, enable paper trading | Playwright | User types strategy description, AI produces SIR, backtest runs, equity curve renders correctly. |

Look-ahead bias detection is built into the golden dataset tests. Any code change that causes a strategy to produce different trade timing on the same data triggers an immediate test failure and blocks the merge — the developer must verify the change is intentional and update the golden fixtures manually.

---

## 5. CI/CD Pipeline

Every code change triggers an automated pipeline via GitHub Actions. The pipeline has three trigger conditions with different scope.

| Trigger | Steps Executed | Target |
|---|---|---|
| **Every push to any branch** | 1. ruff lint (Python) + ESLint (TypeScript) → 2. mypy type check → 3. Unit tests → 4. Golden dataset regression tests → 5. Docker image build | Local validation |
| **Merge to `main`** | All of the above, plus: 6. Integration tests against test database → 7. Docker image push to registry → 8. Automated deploy to staging → 9. Smoke test (health endpoint check) | Staging deploy |
| **Manual trigger only** | All of the above, plus: 10. Production deploy via Docker Compose pull + restart (live trading engine flag state is unchanged by deploy) | Production deploy |

**Critical rule:** The live trading engine is never deployed automatically. Step 10 deploys updated application code, but the live trading feature flag state in Doppler is not changed by the pipeline. Enabling or disabling live trading always requires a separate, explicit operator action.

If the golden dataset regression tests fail on any branch, the build is blocked immediately and no further steps execute. The developer must verify that any change to backtest output is intentional and update the golden fixtures manually before the merge can proceed.

---

## 6. Deployment Architecture

The system runs on a **single VPS** for simplicity of operation. A mid-range server (8 CPU cores, 32GB RAM) handles the full stack comfortably at solo trader scale. Docker Compose manages all services. Nginx terminates SSL and routes traffic.

### Three Environments

| Environment | Purpose | OANDA Mode | Key Differences |
|---|---|---|---|
| **Local (dev)** | Active development and testing | Mocked responses | Hot reload enabled. Reduced dataset (1 year). All debug tooling active. No SSL required. |
| **Staging** | Pre-production validation and paper trading gate | Demo account | Identical config to production. Full dataset. SSL active. Paper trading only. |
| **Production** | Live operation | Live account | Hardened config. No debug endpoints. Automated backups active. Live trading flag controllable. |

### Docker Compose Service Layout

| Service | Image | Exposure | Notes |
|---|---|---|---|
| `nginx` | nginx:alpine | Ports 80, 443 to internet | Reverse proxy + SSL termination. Routes `/api` → fastapi, `/ws` → websocket, `/` → nextjs. |
| `fastapi` | Custom Python image | Port 8000 internal only | Main API, WebSocket hub, Celery task dispatch. Never exposed directly to internet. |
| `nextjs` | Custom Node image | Port 3000 internal only | Frontend served by Next.js SSR. Nginx proxies all public requests here. |
| `timescaledb` | timescale/timescaledb | Port 5432 internal only | Primary database with pgvector extension. Port never exposed to internet. |
| `clickhouse` | clickhouse/clickhouse | Port 8123 internal only | Analytics queries only. Populated by Celery workers after each backtest completion. |
| `redis` | redis:alpine | Port 6379 internal only | Price pub/sub, Celery broker, session cache. Port never exposed to internet. |
| `celery` | Same as fastapi | No port (worker only) | Backtest workers. Shares code with fastapi image. Scale horizontally if needed. |
| `prometheus` | prom/prometheus | Port 9090 internal only | Scrapes metrics from all services. Accessible only via SSH tunnel. |
| `grafana` | grafana/grafana | Port 3001 internal only | Dashboards for system and trading metrics. Accessible via SSH tunnel. |

---

## 7. Observability & Alerting

### 7.1 Metrics & Dashboards

Prometheus scrapes metrics from all services every 15 seconds. Grafana provides dashboards across four domains.

| Dashboard | Key Metrics |
|---|---|
| **System Health** | CPU and memory per container, API request latency (p50/p95/p99), error rate, database connection pool usage, Redis memory, Celery queue depth |
| **Live Trading** | Open positions and running P&L, signals generated vs orders submitted (should be 1:1), OANDA API latency, daily P&L running total, kill switch status |
| **Backtest Monitor** | Active Celery workers, backtest job duration histogram, queue depth, TimescaleDB query latency, disk space used by price data |
| **RAG Performance** | Embedding generation latency, retrieval latency (target < 200ms), chunks retrieved per query, total document count in RAG store |

### 7.2 Alerting Tiers

All alerts route to the operator's phone. Three priority tiers ensure the right urgency for each event type.

| Tier | Condition | Expected Response | Delivery |
|---|---|---|---|
| 🔴 **CRITICAL** | Live position opened but no broker confirmation after 10 seconds. Daily loss exceeds configured threshold. Any uncaught exception in live trading engine. Database connection lost. Kill switch activated. | Immediate — under 5 minutes. | Push notification / PagerDuty |
| 🟡 **WARNING** | Backtest job running over 15 minutes. OANDA API latency over 500ms for 3 consecutive calls. RAG retrieval returning 0 results. Disk over 80% capacity. Daily P&L approaching loss limit. | Investigate within the hour. | Slack / email |
| 🔵 **INFO** | Backtest completed. Strategy version saved. New conversation session started. Daily backup succeeded. Signal generated but filtered by risk rules. | Review in daily log check. No urgency. | Loki log (searchable) |

### 7.3 Structured Logging

All services emit structured JSON logs collected by Loki. Every log entry includes a service name, event type, correlation ID (for tracing requests across services), and relevant context fields. This enables searching across all services by trade ID, strategy version, or session ID in a single Grafana query.

```json
{
  "service": "live-trading",
  "event": "trade_executed",
  "correlation_id": "req_abc123",
  "strategy_id": "rsi-ema-v4",
  "pair": "EURUSD",
  "direction": "long",
  "size": 10000,
  "entry_price": 1.08542,
  "timestamp": "2026-04-02T09:32:14Z",
  "latency_ms": 23
}
```

---

## 8. Pre-Production Security Checklist

All items must be verified before the live trading feature flag is enabled with real capital for the first time.

| Category | Item | Verified By |
|---|---|---|
| **Secrets** | No secrets in git history (check with `git log --all -S '<key>'`) | Manual git audit |
| **Secrets** | All secrets loaded from Doppler, confirmed via env var check in each container on startup | Container startup log check |
| **Network** | UFW firewall allows only ports 80, 443, and 22 (SSH). All others blocked. | `sudo ufw status verbose` |
| **Network** | Database and Redis ports confirmed unreachable from the public internet | External port scan (nmap) |
| **HTTPS** | SSL certificate valid and auto-renewing. HTTP permanently redirects to HTTPS. | `curl -I http://domain.com` |
| **Authentication** | JWT secret is minimum 256-bit randomly generated key stored only in Doppler | Doppler secret inspection |
| **Broker API** | OANDA API key has trading permissions only. Withdrawal and account management permissions are disabled. | OANDA account settings review |
| **Kill Switch** | Kill switch tested end-to-end: triggers cleanly, closes all demo positions, confirms disabled state in Grafana | Live test on staging |
| **Backups** | Automated daily backup confirmed running. Full restore to an empty VPS tested and timed. | Manual restore test |
| **Paper Gate** | 30 consecutive days of paper trading completed on staging with zero uncaught exceptions in the trading engine | Staging log audit |
| **Monitoring** | All Grafana dashboards display live data. All Prometheus alert rules confirmed firing correctly on test triggers. | Alert test in Grafana |
| **Loss Limit** | Daily maximum loss threshold configured and tested: engine disables itself when threshold is hit in simulation | Paper trading simulation |

---

*Forex AI Trading Platform — Implementation Roadmap v1.0 — April 2026*