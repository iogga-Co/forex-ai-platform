# Forex AI Platform — Production Hardening Roadmap

Derived from the Gemini audit (April 2026), Suggestions.md, and architectural review.
Items are ordered by priority within each phase. Severities from the audit are noted where applicable.

**Status as of 2026-04-27:** Phases 5.0, 5.1, and 5.2 are complete. Phase 5.3 and 5.4 are pending.

---

## Phase 5.0 — Live Trading Hardening (Pre-Capital Gate)

These must be resolved before any real capital is committed. All are backend fixes
with no major architectural changes required.

---

### 5.0.1 — ATR Fallback Abort `[CRITICAL]`

**File:** `backend/live/executor.py:162`

**Problem:** `atr_value = 0.0005` is hardcoded as a fallback when ATR is not present
in the signal payload. If the real ATR is 10× higher, position sizing will be 10×
over-leveraged — an account-ruin risk.

**Tasks:**
- [x] Extend the signal payload in `live/engine.py` to include the computed ATR value
      for the SL indicator period (already calculated during bar check — just add to the
      `dict` passed to `_publish_signal`)
- [x] In `executor.py`, read `atr_value` from the incoming signal dict
- [x] Add a hard abort: if `atr_value` is missing or `<= 0`, log a critical error and
      **skip order placement entirely** — do not fall back to any hardcoded value
- [x] Add a unit test covering the abort path (signal with no ATR → no order submitted)

---

### 5.0.2 — Position Reconciliation on Startup `[HIGH]`

**File:** `backend/live/executor.py` (new method)

**Problem:** If the platform goes offline while a position is open and OANDA hits the
SL/TP, the `live_orders` table stays in `filled` state permanently. The kill-switch
count and P&L calculations are then wrong for the rest of the session.

**Tasks:**
- [x] Implement `_reconcile_on_startup(r, pool)` in `executor.py`:
  - Fetch all `live_orders` rows with `status = 'filled'`
  - For each, call `OandaClient.get_trade(trade_id)` to check current state
  - If OANDA reports the trade as closed, update the DB row to `status = 'closed'`
    and record `exit_price`, `exit_time`, `pnl` from the OANDA response
- [x] Call `_reconcile_on_startup()` at the top of `executor.run()` before the
      main subscription loop starts
- [x] Log a summary: `"Reconciled N stale positions on startup"`

---

### 5.0.3 — Pip Size InstrumentRegistry `[HIGH]`

**Files:** `backend/engine/parser.py:96`, `backend/live/executor.py:53`

**Problem:** `"JPY" in symbol` string check is fragile. Fails for non-standard pairs
(`XAUUSD`, `USDMXN`) and inconsistent naming (`EUR/JPY` vs `EURJPY`). Duplicated in
two places.

**Tasks:**
- [x] Create `backend/core/instruments.py` with a `PIP_SIZES` dict:
  ```python
  PIP_SIZES = {
      "EURUSD": 0.0001, "GBPUSD": 0.0001, "USDCHF": 0.0001,
      "EURGBP": 0.0001, "USDJPY": 0.01,   "GBPJPY": 0.01,
      "EURJPY": 0.01,   "XAUUSD": 0.01,
  }
  def get_pip_size(symbol: str) -> float:
      return PIP_SIZES.get(symbol.replace("/", "").upper(), 0.0001)
  ```
- [x] Replace the `"JPY" in self._symbol` check in `parser.py` with `get_pip_size()`
- [x] Replace the same pattern in `executor.py` with `get_pip_size()`
- [x] (Optional) On startup, call `GET /v3/instruments` from OANDA and validate/update
      `PIP_SIZES` against `pipLocation` — store as runtime override

---

### 5.0.4 — MFA for Operator Role `[HIGH]`

**File:** `backend/routers/auth.py`, `backend/routers/trading.py`

**Problem:** The single `operator_password` is the only gate for live order execution.
Vulnerable to brute-force; high stakes once real capital is involved.

**Tasks:**
- [x] Add TOTP-based MFA using `pyotp`:
  - New DB column: `users.totp_secret VARCHAR(32)` (nullable — only set for operator)
  - New endpoint `POST /api/auth/mfa/setup` — generates and returns a TOTP secret +
    QR code URI for the operator account; stores secret on confirmation
  - New endpoint `POST /api/auth/mfa/verify` — accepts TOTP code, issues a
    short-lived `mfa_token` (15-min JWT) alongside the regular access token
- [x] Add `require_mfa` dependency for kill-switch and any order-placement endpoints
      in `routers/trading.py` — checks for valid `mfa_token` in request headers
- [x] Frontend: add MFA setup flow in Settings page; add TOTP prompt before
      kill-switch confirmation dialog

---

## Phase 5.1 — Microservice Decomposition (Trading Service Isolation)

**Goal:** Decouple the OANDA feed, signal engine, and executor from the FastAPI
web process so that a web/API crash cannot kill the live trading loop.

**Current architecture:** all three run as `asyncio.Task` inside FastAPI's lifespan.
**Target architecture:** separate `trading-service` Docker container with its own
Python entry point. The web API communicates with it exclusively via Redis.

The components already talk via Redis pub/sub (`ticks:{pair}`, `live:signals`) —
feed and engine move for free. Only the executor needs a Redis command channel for
the kill-switch endpoint.

---

### 5.1.1 — Trading Service Entry Point

**Tasks:**
- [x] Create `backend/trading_service.py` — standalone asyncio entry point:
  ```python
  async def main():
      pool = await create_db_pool()
      stop = asyncio.Event()
      await asyncio.gather(
          run_feed(stop),
          run_engine(stop, pool),
          run_executor(stop, pool),   # new signature — pool passed in
      )
  ```
- [x] Add `asyncio.signal` handlers for `SIGTERM`/`SIGINT` that set `stop`
- [x] Verify `executor.py` can accept an externally-created pool (refactor
      `LiveExecutor.__init__` to take `pool` as a parameter)

---

### 5.1.2 — Redis Command Channel for Kill-Switch

**Problem:** `routers/trading.py` calls `executor.kill_switch()` directly
(in-process). After decomposition the executor is in another process.

**Tasks:**
- [x] Define a Redis command channel `live:commands` with a JSON envelope:
  ```json
  { "cmd": "kill_switch", "request_id": "<uuid>", "user_id": "<uid>" }
  ```
- [x] In `executor.py`, add a coroutine that subscribes to `live:commands`
      and dispatches to `self.kill_switch()` on receipt; publishes result to
      `live:cmd_results:{request_id}`
- [x] In `routers/trading.py`, replace the direct `executor.kill_switch()` call
      with a publish to `live:commands` + a `blpop` wait on `live:cmd_results:{id}`
      with a 10-second timeout
- [x] For `GET /api/trading/status` — open position count can be read directly from
      DB; remove the `get_executor()` call entirely (it only uses DB currently)

---

### 5.1.3 — Strip Lifespan Tasks from FastAPI

**Tasks:**
- [x] Remove `run_feed`, `run_engine`, `LiveExecutor` imports and task creation from
      `backend/main.py` lifespan
- [x] Remove `get_executor` / `set_executor` singleton from `live/executor.py` (no
      longer needed — executor runs in its own process)
- [x] Keep the Redis bridge task (WebSocket ping) in FastAPI lifespan — it belongs
      to the web layer

---

### 5.1.4 — Docker Compose Service

**Tasks:**
- [x] Add `trading-service` to `docker-compose.yml`:
  ```yaml
  trading-service:
    build: ./backend
    command: python trading_service.py
    depends_on: [timescaledb, redis]
    restart: unless-stopped
  ```
- [x] Add to `docker-compose.dev.yml`: bind mount + env vars for hot reload
- [x] Update CI deploy script: include `trading-service` in the recreate sequence
      (after `fastapi celery`, before `nextjs`)
- [x] Update `CLAUDE.md` restart instructions: add
      `docker compose restart trading-service` for `live/` code changes

---

### 5.1.5 — Health Check Endpoint

**Tasks:**
- [x] Add a lightweight HTTP health check to `trading_service.py` (a single-route
      FastAPI app on port 8001, or just write a Redis key `live:heartbeat` every 30s)
- [x] Docker Compose `healthcheck` reads the Redis key or pings the port
- [x] Staging: confirm Nginx does NOT proxy port 8001 (internal only)

---

## Phase 5.2 — UX & Stability Quick Wins

These are independent of the above and can be done in any order.

---

### 5.2.1 — Toast Notification System

**Problem:** Background task completions (backtest finish, optimization done) use
browser `alert()` or are silent.

**Tasks:**
- [x] Install `sonner` (`npm install sonner`)
- [x] Add `<Toaster />` to `frontend/src/app/layout.tsx`
- [x] Replace all `alert()` calls and silent completions with `toast.success()` /
      `toast.error()` across backtest, optimization, and g-optimize pages
- [x] On SSE `done` events from optimization/g-optimize streams, fire a toast if the
      tab is in the background

---

### 5.2.2 — OANDA Feed Heartbeat Handling

**File:** `backend/live/feed.py`

**Problem:** OANDA sends periodic heartbeat messages on the tick stream. Unhandled
heartbeats may cause the reconnect logic to misidentify silent drops.

**Tasks:**
- [x] In `feed.py`, explicitly detect `"type": "HEARTBEAT"` in the OANDA stream
      response and update a `last_heartbeat_at` timestamp (no other action needed)
- [x] If no heartbeat received within 30s, log a warning and trigger reconnect

---

### 5.2.3 — Shutdown Timeouts in main.py

**File:** `backend/main.py` lifespan teardown

**Tasks:**
- [x] Wrap each `await _task` in the lifespan shutdown with
      `asyncio.wait_for(..., timeout=10.0)`
- [x] On `asyncio.TimeoutError`, log a warning and `task.cancel()` — prevents zombie
      processes blocking deployment restarts

---

### 5.2.4 — Metric Tooltips in BacktestResultPanel

**File:** `frontend/src/components/BacktestResultPanel.tsx`

**Tasks:**
- [x] Add a `Tooltip` component (inline CSS, no new dependency) with definitions for:
      Sharpe Ratio, Profit Factor, Max Drawdown, R-Multiple, Win Rate
- [x] Wrap each metric label with the tooltip — hover shows definition
- [x] Keep tooltip text concise (1 sentence)

---

### 5.2.5 — SSE Client Reconnection with Exponential Backoff

**Files:** optimization and g-optimize frontend pages

**Problem:** `EventSource` reconnects immediately on failure — can hammer the server
if the backend is restarting.

**Tasks:**
- [x] Replace raw `new EventSource(url)` with a thin wrapper that:
  - On `onerror`, waits `min(2^attempt × 1000ms, 30000ms)` before reconnecting
  - Resets backoff counter on `onopen`
- [x] Apply to `optimization/page.tsx` and `g-optimize/page.tsx` SSE connections

---

### 5.2.6 — Automated Data Quality on Backfill

**File:** `backend/scripts/backfill.py`, `backend/data/quality.py`

**Tasks:**
- [x] After each pair's ingest in `backfill.py`, call the quality check functions
      from `data/quality.py` on the newly loaded range
- [x] Log a summary per pair: rows loaded, gaps detected, rows skipped
- [x] On `--strict` flag, abort the backfill if quality checks fail

---

### 5.2.7 — Dual-Axis Equity + Drawdown Chart

**File:** `frontend/src/components/BacktestResultPanel.tsx`

**Problem:** Equity curve and drawdown are separate charts — hard to see the
relationship between account growth and risk periods.

**Tasks:**
- [x] Combine into a single Recharts chart with two Y-axes: equity (left), drawdown % (right)
- [x] Drawdown series rendered as a filled area below zero in red
- [x] Retain existing zoom/pan behaviour

---

### 5.2.8 — Loading State Polish (Skeleton Loaders)

**Files:** backtest, optimization, g-optimize pages

**Tasks:**
- [x] Replace generic spinners with skeleton placeholders that match the final
      layout shape (result panel columns, trade table rows)
- [x] Prevents layout shift when data arrives

---

### 5.2.9 — Indeterminate Checkbox Verification

**File:** `frontend/src/components/BacktestResultPanel.tsx`

**Tasks:**
- [x] Verify the select-all checkbox shows indeterminate state correctly when a
      partial set of trades is selected (uses `ref` callback — confirm it fires
      on every render, not just mount)
- [x] If broken: move `ref` callback to a `useEffect` that sets
      `el.indeterminate = checkedCount > 0 && checkedCount < total`

---

### 5.2.10 — Global Density Toggle

**File:** `frontend/src/app/settings/page.tsx`, `frontend/src/app/globals.css`

**Tasks:**
- [x] Add `ui_density: "compact" | "spacious"` to the settings schema in `lib/settings.ts`
- [x] In `globals.css`, wrap the padding compression overrides in a `:root.compact` class
- [x] On settings change, toggle the class on `<html>` — compact is the default (current behaviour)

---

### 5.2.11 — Dark Mode WCAG Contrast Review

**Tasks:**
- [x] Audit `text-slate-500` and `text-slate-400` usages against their backgrounds
      using a contrast checker (target: WCAG AA — 4.5:1 for body text)
- [x] Adjust problem colours in `globals.css` or swap Tailwind classes where contrast fails
- [x] Focus on trade table, metric labels, and sidebar text — highest-density areas

---

### 5.2.12 — Test Settings Overrides in CI

**File:** `backend/core/config.py`

**Problem:** `Settings` reads from environment variables — unit tests in CI must
set env vars to override, which is fragile and couples tests to the environment.

**Tasks:**
- [x] Refactor `Settings` to accept an optional `_env_overrides: dict` at construction
- [x] Update test fixtures to pass overrides directly instead of setting env vars
- [x] Verify pytest passes in CI without any live secrets in the env

---

### 5.2.13 — Test Coverage for `strategyLabels.ts`

**File:** `frontend/src/lib/strategyLabels.ts`

**Tasks:**
- [x] Add Jest unit tests covering `conditionToLabel`, `exitConditionToLabel`,
      and `filterToLabels` for all supported indicators (RSI, EMA, SMA, MACD,
      BB, ATR, ADX, STOCH)
- [x] Add regression cases for MACD (`fast`/`slow`/`signal_period`) and BB (`std_dev`)
      — these have non-standard field names that are easy to break

---

### 5.2.14 — Frontend Integration Guide

**File:** `docs/api-integration.md` (new)

**Tasks:**
- [x] Document the two-step trade analysis flow (`/trades/stats` → `/trades/analyze`)
- [x] Document all diagnosis endpoints with request/response shapes and field meanings
- [x] Document SSE stream events (optimization, g-optimize) with field-by-field breakdown
- [x] Keep it short — complement `/docs` (Swagger), don't replace it

---

## Phase 5.3 — Advanced Execution (Post-MVP)

Lower priority — revisit after 5.0 and 5.1 are stable.

- [ ] **Limit order support** — submit limit entries instead of market orders;
      add `order_type: "market"|"limit"` to signal payload and SIR
- [ ] **Dynamic spread estimation in backtester** — apply pair-specific average
      spread cost per trade in `engine/metrics.py` to reduce backtest-to-live gap
- [ ] **TWAP execution** — split large orders into time-weighted slices for pairs
      with thin liquidity (EURGBP, USDCHF)

---

## Phase 5.4 — RAG Evaluation Framework (Post-MVP)

- [ ] Integrate an LLM-as-a-judge framework (G-Eval or Ragas) to score the quality
      of G-Optimize strategy summaries stored in `strategies.description`
- [ ] Run evaluations on a sample after each G-Optimize batch; log scores to a new
      `rag_eval_log` table
- [ ] Alert (via toast or email) if average score drops below threshold

---

## Summary table

| ID | Item | Severity | Phase | Effort |
|---|---|---|---|---|
| 5.0.1 | ATR fallback abort | Critical | 5.0 | S |
| 5.0.2 | Position reconciliation on startup | High | 5.0 | M |
| 5.0.3 | Pip size InstrumentRegistry | High | 5.0 | S |
| 5.0.4 | MFA for operator role | High | 5.0 | L |
| 5.1.1 | Trading service entry point | Medium | 5.1 | S |
| 5.1.2 | Redis kill-switch command channel | Medium | 5.1 | M |
| 5.1.3 | Strip lifespan tasks from FastAPI | Medium | 5.1 | S |
| 5.1.4 | Docker Compose trading-service | Medium | 5.1 | S |
| 5.1.5 | Trading service health check | Low | 5.1 | S |
| 5.2.1 | Toast notification system | Low | 5.2 | S |
| 5.2.2 | OANDA heartbeat handling | Low | 5.2 | S |
| 5.2.3 | Shutdown timeouts in main.py | Low | 5.2 | S |
| 5.2.4 | Metric tooltips in BacktestResultPanel | Low | 5.2 | S |
| 5.2.5 | SSE exponential backoff | Low | 5.2 | S |
| 5.2.6 | Automated data quality on backfill | Low | 5.2 | S |
| 5.2.7 | Dual-axis equity + drawdown chart | Low | 5.2 | M |
| 5.2.8 | Skeleton loader polish | Low | 5.2 | S |
| 5.2.9 | Indeterminate checkbox verification | Low | 5.2 | S |
| 5.2.10 | Global density toggle | Low | 5.2 | S |
| 5.2.11 | Dark mode WCAG contrast review | Low | 5.2 | S |
| 5.2.12 | Test settings overrides in CI | Low | 5.2 | S |
| 5.2.13 | strategyLabels.ts test coverage | Low | 5.2 | S |
| 5.2.14 | Frontend integration guide | Low | 5.2 | S |
| 5.3 | Limit orders / TWAP / spread estimation | — | 5.3 | L |
| 5.4 | RAG evaluation framework | — | 5.4 | L |

**Effort key:** S = hours · M = 1–2 days · L = 3–5 days
