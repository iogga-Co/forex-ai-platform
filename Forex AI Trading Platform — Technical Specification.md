# Forex AI Trading Platform — Technical Specification

**Version:** 1.0
**Date:** April 2026
**Scale:** Solo, Production-Grade

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [System Architecture](#2-system-architecture)
3. [Component Specifications](#3-component-specifications)
   - 3.1 [Data Pipeline](#31-data-pipeline)
   - 3.2 [AI Co-Pilot & Strategy Engine](#32-ai-co-pilot--strategy-engine)
   - 3.3 [RAG Memory Layer](#33-rag-memory-layer)
   - 3.4 [Backtesting Engine](#34-backtesting-engine)
   - 3.5 [Analytics & Visualization Suite](#35-analytics--visualization-suite)
   - 3.6 [Live Trading Engine](#36-live-trading-engine)
4. [Technology Stack](#4-technology-stack)
5. [Core Data Model](#5-core-data-model)
6. [Security Requirements](#6-security-requirements)
7. [Non-Functional Requirements](#7-non-functional-requirements)

---

## 1. Executive Summary

This document defines the full technical specification for a Forex AI Trading Platform — a solo, production-grade system combining historical backtesting, AI-driven strategy co-creation, persistent RAG-based memory, and live order execution. The platform is designed to give a single trader the analytical depth of a quantitative workflow, with a conversational AI interface as the primary strategy design tool.

The system is built around five core principles:

1. All strategy logic is created through natural language conversation with an AI Co-Pilot, not through code or form-based inputs.
2. Every conversation turn, backtest result, strategy version, and trade outcome is permanently stored in a RAG memory layer, so the AI always builds on prior context rather than starting from zero.
3. All backtest analytics are maximally rich — not just aggregate metrics, but per-trade, per-session, and per-period breakdowns with fully interactive visualization.
4. Live trading is treated as a strictly controlled gate, enabled only after a mandatory paper trading validation period.
5. Determinism is a first-class requirement: identical strategy inputs on identical data must always produce identical results.

---

## 2. System Architecture

The platform is composed of six tightly integrated subsystems. Each has well-defined responsibilities and communicates through documented interfaces. A shared data layer underpins all subsystems.

| Subsystem | Core Responsibility | Key Technology |
|---|---|---|
| **Data Pipeline** | Ingest, clean, and store historical and real-time OHLCV price data | TimescaleDB, Redis, Dukascopy |
| **AI Co-Pilot** | Conversational strategy design through natural language dialogue with Claude | Claude API, FastAPI WebSocket |
| **RAG Memory Layer** | Persistent storage and retrieval of all dialogs, strategy versions, and backtest results for AI context | pgvector, PostgreSQL, BM25 |
| **Backtesting Engine** | Simulate strategy execution on historical data with deterministic, reproducible results | vectorbt, Celery, Python |
| **Analytics Suite** | Interactive trade tables, performance charts, MAE/MFE, Monte Carlo simulation, strategy comparison | AG Grid, Plotly.js, TradingView |
| **Live Trading Engine** | Real-time order execution, position management, risk controls, and emergency kill switch | OANDA v20 API, Redis pub/sub |

### High-Level Data Flow

```
User (Natural Language)
        │
        ▼
AI Co-Pilot (Claude API)
  ├── RAG retrieval (pgvector + BM25)
  ├── Current Strategy IR
  └── Generates / refines Strategy IR (JSON)
        │
        ▼
┌───────────────────────────────────────┐
│          Strategy IR (JSON)           │
└───────────────────────────────────────┘
        │                    │
        ▼                    ▼
Backtesting Engine      Live Trading Engine
  (vectorbt)              (OANDA v20 API)
        │                    │
        ▼                    ▼
Analytics Suite         Trade Log → RAG
(charts, tables,        (feedback loop)
 MAE/MFE, Monte Carlo)
```

---

## 3. Component Specifications

### 3.1 Data Pipeline

The data pipeline is responsible for ingesting, normalizing, and storing all price data used by the backtesting and live trading engines. Two data modes are supported: historical batch ingestion and real-time streaming.

| Source | Data Type | Mode | Storage Target |
|---|---|---|---|
| Dukascopy | Tick + OHLCV (1m to 1M) | Historical batch | TimescaleDB `ohlcv_candles` hypertable |
| yfinance | Daily OHLCV | Daily batch | TimescaleDB (supplemental) |
| OANDA Streaming | Real-time bid/ask ticks | Live < 100ms | Redis pub/sub channel (rolling 24h window) |

All candle data is stored in TimescaleDB with hypertable partitioning by time. Composite indexes on `(pair, timeframe, timestamp)` enable sub-second range queries across years of data. Redis serves as the real-time cache for live strategy evaluation and signal streaming to the frontend.

---

### 3.2 AI Co-Pilot & Strategy Engine

The Co-Pilot is the primary user interface for strategy creation. All strategy definition happens through multi-turn natural language dialogue. Claude serves as the reasoning engine. The AI does not generate executable code — it builds and refines a structured Strategy Intermediate Representation (SIR) through conversation.

#### Interaction Pipeline

When a user submits a message, the following steps execute before Claude generates a response:

1. The message is embedded using a finance-specific model (Voyage AI `voyage-finance-2`)
2. A hybrid retrieval query runs against the RAG store: vector similarity for semantic matches + BM25 for exact term matches on tickers and indicator names
3. Top-k retrieved chunks (prior dialogs, backtest summaries, strategy versions) are assembled into context
4. Claude receives the system prompt, user message, retrieved context, and the current Strategy IR
5. Claude responds with suggestions, trade-off explanations, or a proposed update to the SIR
6. Both the user and AI turn are embedded and written to the RAG store for future retrieval

#### Strategy Intermediate Representation (SIR)

All strategies are stored as a structured JSON document — the canonical strategy representation. It is human-readable, versionable, and passed directly to the execution engine without LLM involvement at runtime. This ensures strategy execution is fully deterministic and auditable.

```json
{
  "entry_conditions": [
    { "indicator": "RSI", "period": 14, "operator": ">", "value": 50 },
    { "indicator": "EMA", "period": 20, "operator": "price_above" },
    { "indicator": "RSI", "period": 14, "operator": "<", "value": 65 }
  ],
  "exit_conditions": {
    "stop_loss": { "type": "atr", "period": 14, "multiplier": 1.5 },
    "take_profit": { "type": "atr", "period": 14, "multiplier": 3.0 }
  },
  "filters": {
    "exclude_days": ["Monday"],
    "session": "london_open"
  },
  "position_sizing": {
    "risk_per_trade_pct": 2.0,
    "max_size_units": 100000
  },
  "metadata": {
    "version": 4,
    "created_from_turn_id": "conv_abc123",
    "description": "RSI momentum with EMA trend filter, ATR-based exits, London session only",
    "change_summary": "Added London session filter based on hour-of-day analysis showing edge concentrated in 07:00–11:00 UTC"
  }
}
```

| SIR Field | Type | Description |
|---|---|---|
| `entry_conditions` | Array | Indicator-based conditions that must all evaluate to true for trade entry |
| `exit_conditions` | Object | Stop-loss and take-profit rules (fixed, ATR-based, or indicator-based) plus time exits |
| `filters` | Object | Session filters, day-of-week exclusions, volatility filters, economic calendar flags |
| `position_sizing` | Object | Risk per trade as percentage of capital, maximum position size cap |
| `metadata` | Object | Version number, source conversation turn ID, natural language description, change summary |

---

### 3.3 RAG Memory Layer

The RAG layer provides the AI with persistent, contextually retrieved memory across all sessions. Every interaction is stored, embedded, and indexed so that the AI's suggestions are always grounded in the full history of what has been tested, discussed, and observed.

| Entity Stored | What Gets Indexed | When Retrieved |
|---|---|---|
| **Conversation turns** | Full text of every user and AI message, tagged with pair, timeframe, and strategy version | On any new message — semantically similar past dialogs surface automatically |
| **Strategy IR versions** | Natural language description of strategy rules and a summary of what changed from the previous version | When user mentions a pair, indicator, or strategy type previously discussed |
| **Backtest summaries** | Auto-generated prose summary: metrics, key strengths, weaknesses, problematic market conditions | When user asks about performance, a pair, or proposes a similar strategy |
| **Trade annotations** | Per-trade context: signal values at entry, market regime, session, MAE, MFE, and outcome | When analyzing trade clusters, drawdown periods, or specific signal patterns |
| **User corrections** | Explicit feedback the user gives the AI (e.g. "GBP/JPY is too volatile on news days") | Proactively retrieved when the relevant pair, condition, or instrument is mentioned |

Retrieval uses a **hybrid approach**: pgvector cosine similarity for semantic matching, combined with a BM25 keyword index for exact matches on ticker symbols, metric values, and indicator names. Results are re-ranked by a combined relevance and recency score before being injected into Claude's context window.

After every completed backtest, the system automatically generates a natural language summary using Claude. This summary captures the character of the strategy's performance — not just the numbers, but when it worked, when it failed, and under what market conditions — and stores it immediately in the RAG store.

---

### 3.4 Backtesting Engine

The backtesting engine simulates strategy execution against historical OHLCV data using **vectorbt**, a vectorized library that processes years of data in seconds by operating across pandas DataFrames rather than looping through events.

**Determinism Requirement**

The same Strategy IR applied to the same historical dataset must always produce identical trades and metrics, regardless of when or how many times it is run. This is enforced by a suite of golden dataset regression tests that run in CI on every commit.

**Look-Ahead Bias Prevention**

All signals are evaluated on the close of bar N and executed at the open of bar N+1. No future data is accessible during signal computation. This enforced one-bar lag prevents look-ahead bias — the most dangerous bug in backtesting, which causes a losing strategy to appear profitable.

**Execution Model**

Backtests are executed as background jobs via Celery workers, keeping the API responsive during multi-year, multi-pair runs. Progress is streamed to the frontend via WebSocket. On completion, results are written to TimescaleDB and immediately queued for RAG indexing and auto-summary generation by Claude.

---

### 3.5 Analytics & Visualization Suite

After each backtest, the system presents a comprehensive set of interactive analytics designed to answer three questions: where is the edge in this strategy, what are the specific risks, and what should be changed next.

| Analytic | Description | Interactivity |
|---|---|---|
| **Master Trade Table** | Every trade as a row: entry/exit times, P&L, R-multiple, MAE, MFE, session, day of week, signal values at entry | Filter, sort, group by any column; click row to open that trade on the price chart |
| **Equity Curve + Drawdown** | Cumulative P&L curve overlaid with underwater drawdown plot on a shared time axis | Click a drawdown trough to filter the trade table to that exact period |
| **Monthly Returns Heatmap** | Calendar grid: rows are years, columns are months, color intensity encodes return. Reveals seasonality and structural bad months. | Click any cell to filter to that calendar month |
| **Win Rate by Hour** | Bar chart of win rate, average R, and trade count by hour of day. Reveals session-specific edge concentration. | Hover for full statistics per hour; click to filter trade table |
| **P&L Distribution** | Histogram of trade P&L and R-multiple. Shows whether distribution is fat-tailed or has consistent small wins. | Adjustable bin width; separate view for longs vs shorts |
| **MAE / MFE Scatter** | Each trade plotted by maximum adverse excursion (x-axis) vs maximum favorable excursion (y-axis), colored by outcome. Reveals whether stops and targets are optimally placed. | Click any point to jump to that trade on the price chart |
| **Monte Carlo Simulation** | 1,000+ randomized shuffles of the trade sequence to derive the distribution of possible equity curve outcomes. Shows 5th, 50th, and 95th percentile paths. | Adjustable simulation count; hover for percentile values |
| **Rolling Metrics** | 30/60/90-day rolling Sharpe ratio, win rate, and average R over time. Detects strategy decay or regime shifts. | Adjustable rolling window; overlay multiple metrics simultaneously |
| **Streak Analysis** | Consecutive win/loss streaks, autocorrelation of returns, and probability of N consecutive losses based on historical distribution. | Visual trade sequence display with streak highlights |
| **Strategy Comparison** | Side-by-side table of all strategy versions: Sharpe, max drawdown, win rate, average trade, trade count, and the key change made from the prior version. | Select any two versions to run a metric diff |

Every chart and table includes an **"Ask AI about this"** button that passes the current view's data directly to the Co-Pilot, enabling context-aware analysis and actionable suggestions from within the analytics interface.

---

### 3.6 Live Trading Engine

The live trading engine is the most safety-critical component in the system. It connects to the OANDA v20 REST and streaming API to evaluate strategy signals in real time and submit orders under strict risk controls.

| Sub-Component | Responsibility |
|---|---|
| **Signal Evaluator** | Evaluates Strategy IR conditions against the latest tick data from Redis. Runs on configurable tick or bar intervals. |
| **Risk Manager** | Enforces maximum position size, daily loss limit, maximum concurrent open trades, and minimum interval between trades before any order is submitted. |
| **Order Manager** | Submits market orders to OANDA v20 REST API, tracks confirmation status, handles partial fills and rejections with exponential backoff retry. |
| **Position Tracker** | Maintains current open positions, running P&L, and live stop levels in Redis, synced from OANDA account state every 5 seconds. |
| **Kill Switch** | Single authenticated API endpoint that immediately halts all signal evaluation, closes all open positions at market price, and disables the engine until manually re-enabled. |
| **Trade Logger** | Every execution event is written immediately to TimescaleDB and queued for RAG indexing with full execution context. |

The live trading engine is gated behind a feature flag in production. It does not auto-enable on container restart or new deployment. Enabling it requires an explicit authenticated API call each time.

---

## 4. Technology Stack

| Layer | Technology | Rationale |
|---|---|---|
| **Core Language** | Python 3.12 | Dominant language for financial data, AI/ML, backtesting, and broker APIs. Best ecosystem fit across every layer. |
| **API Layer** | FastAPI | Async, high-performance Python framework. Native WebSocket support for real-time price streaming. Auto-generates OpenAPI docs. |
| **Backtesting Engine** | vectorbt | Vectorized execution on pandas DataFrames. Processes years of tick data in seconds. Built-in portfolio analytics. |
| **AI Strategy Engine** | Claude API (`claude-sonnet-4-6`) | Superior financial reasoning and instruction-following for strategy co-creation. Multi-turn conversation with tool use for RAG retrieval. |
| **Embedding Model** | Voyage AI `voyage-finance-2` | Finance-specific embedding model with significantly stronger semantic retrieval on trading terminology than general-purpose models. |
| **Vector Database** | pgvector (on PostgreSQL) | No separate infrastructure. SQL joins work directly between strategy, trade, and embedding tables. Sufficient at solo scale. |
| **Time-Series DB** | TimescaleDB | PostgreSQL extension optimized for OHLCV data. Hypertable partitioning by time. Sub-second range queries across years of price history. |
| **Analytics DB** | ClickHouse | Columnar storage for heavy analytics workloads: per-session stats, rolling window calculations, and distribution queries. |
| **Cache / Pub-Sub** | Redis | Real-time price feed distribution to live trading engine. Celery task broker. Session caching. Sub-millisecond latency. |
| **Task Queue** | Celery | Runs long backtests as async background jobs. Prevents API timeouts. Enables progress streaming and concurrent multi-pair runs. |
| **Frontend** | Next.js (React) | SSR for initial load performance. React ecosystem for complex interactive UI. API routes for BFF pattern. |
| **Price Charts** | TradingView Lightweight Charts | Native financial charting. OHLCV candles, trade marker overlays, indicator plots. Free and highly performant. |
| **Analytics Charts** | Plotly.js | All statistical chart types required: heatmaps, histograms, scatter, Monte Carlo fan charts. Fully interactive. |
| **Data Tables** | AG Grid (React) | Best-in-class interactive grid: virtual scrolling, column filtering, row grouping, CSV/Excel export. |
| **Dashboard Layout** | React Grid Layout | Drag-and-drop panel arrangement, allowing the user to customize their analytics workspace. |
| **Live Broker API** | OANDA v20 REST + Streaming | Forex-focused broker with a well-documented API, free demo account, and server-sent event streaming for real-time ticks. |
| **Containerization** | Docker + Docker Compose | Reproducible local and production environments. All services in a single compose file. Simple to operate solo. |
| **Reverse Proxy** | Nginx + Let's Encrypt | SSL termination, routing to FastAPI and Next.js, rate limiting. Production-grade and free. |
| **Secrets** | Doppler | Centralized secrets management with automatic sync to Docker environment variables. No secrets in code or git. |
| **Observability** | Prometheus + Grafana + Loki | Self-hosted metrics, dashboards, and log aggregation on the same VPS. Full visibility at zero external cost. |

---

## 5. Core Data Model

Entities marked with `*` on text fields have a corresponding `embedding vector(1024)` column for RAG retrieval.

| Entity | Key Fields | Notes |
|---|---|---|
| `ohlcv_candles` | pair, timeframe, timestamp, open, high, low, close, volume | TimescaleDB hypertable. Primary data store for all backtesting queries. |
| `strategies` | id, version, ir_json, description`*`, pair, timeframe, created_from_turn_id, embedding | Every version stored permanently. `description` is RAG-indexed. |
| `conversation_turns` | id, session_id, role, content`*`, strategy_id, timestamp, embedding | Both user and AI turns stored. Full dialog history permanently indexed. |
| `backtest_runs` | id, strategy_id, period_start, period_end, summary_text`*`, sharpe, sortino, max_dd, win_rate, trade_count, embedding | `summary_text` is auto-generated by Claude immediately after each run. |
| `trades` | id, backtest_run_id, entry_time, exit_time, direction, entry_price, exit_price, pnl, r_multiple, mae, mfe, signal_context`*` | Per-trade granularity. `signal_context` stores indicator values at entry. |
| `live_orders` | id, strategy_id, oanda_order_id, status, direction, size, entry_price, exit_price, pnl, opened_at, closed_at | Live execution record. Separate from backtest trades table. |
| `alert_events` | id, level, type, message, resolved, created_at | System-wide event log for monitoring, debugging, and post-incident review. |

---

## 6. Security Requirements

### Secrets & Credentials

- All secrets stored in Doppler (broker API keys, Claude API key, database passwords, JWT secret). Never in code or git history.
- Broker API keys scoped to minimum permissions: order execution only, no withdrawal or account management access.
- API keys rotated every 90 days with automated rotation reminders sent via system alert.
- Secrets injected as environment variables at container startup. Never written to disk inside containers.

### Network Isolation

- Database (TimescaleDB/ClickHouse), Redis, and Celery workers are not exposed to the internet. Accessible only within Docker's internal bridge network.
- Only Nginx on port 443 is exposed publicly. All other ports blocked by UFW firewall rules on the VPS.
- FastAPI runs behind Nginx with rate limiting enforced at the proxy layer (100 req/min per IP by default).

### Live Trading Controls

- Live trading engine gated behind a named feature flag in Doppler. Flag state is checked at engine startup, never cached.
- Engine does not auto-enable on container restart or new deployment. Manual operator action required every time.
- Kill switch endpoint is authenticated (requires valid JWT), rate-limited (1 call per 10 seconds), and reachable from mobile.
- Daily maximum loss threshold enforced at the Risk Manager level. Cannot be bypassed by the Strategy IR or signal evaluator.

### Data & Authentication

- HTTPS enforced everywhere via Let's Encrypt. All HTTP traffic permanently redirected to HTTPS.
- JWT authentication with 15-minute access token TTL plus refresh tokens stored in HttpOnly cookies.
- Daily automated database backups to encrypted off-site storage with 30-day retention and monthly restore tests.

---

## 7. Non-Functional Requirements

| Requirement | Target | Notes |
|---|---|---|
| **Backtest throughput** | < 5 seconds for 4-year 1H EUR/USD | Achieved via vectorbt vectorized execution on pandas DataFrames without event-loop overhead. |
| **AI response time** | < 4 seconds end-to-end | RAG retrieval target under 200ms. Claude streaming response begins before retrieval completes. |
| **Real-time price latency** | < 100ms OANDA tick to Redis | OANDA streaming API uses server-sent events with a single processing hop into Redis pub/sub. |
| **Backtest determinism** | 100% identical output for same inputs | Enforced by golden dataset regression tests in CI pipeline on every commit to main branch. |
| **Analytics query time** | < 1 second for any analytics view | ClickHouse columnar queries on pre-aggregated data computed immediately on backtest completion. |
| **System uptime (prod)** | > 99.5% excluding planned maintenance | Docker Compose on a single VPS. Nginx health checks with automatic container restart on failure. |
| **Data retention** | Unlimited — all history preserved | No automatic deletion of strategies, conversations, or trade logs. Storage is cheap relative to value. |
| **Backup frequency** | Daily automated backups | PostgreSQL and TimescaleDB dumps to encrypted off-site storage with 30-day retention. |
| **Kill switch latency** | < 3 seconds from trigger to flat | Market close orders submitted immediately on activation. Confirmation logged to `alert_events`. |

---

*Forex AI Trading Platform — Technical Specification v1.0 — April 2026*