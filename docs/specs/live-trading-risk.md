# Live Trading — Risk Management & Emergency Intervention Specification

**Phase:** 4 — Live Trading  
**Addendum to:** `Forex AI Trading Platform — Technical Specification.md` § 3.6 Live Trading Engine  
**Date:** April 2026

---

## Overview

This document specifies the risk management subsystem for Phase 4, covering two tightly coupled concerns:

1. **Emergency Kill Switch** — manual operator-triggered halt that flattens all positions and locks the execution engine
2. **Automatic Circuit Breakers** — rule-based triggers that fire the same halt procedure without human intervention

Both converge on a single **Halt Procedure** so there is one code path, one audit trail, and one recovery flow regardless of how the halt was initiated.

---

## 1. System States

The live trading engine operates in exactly one of four states at any time. State is persisted in the `system_state` table (see § 6) — never in memory only. A server restart must restore the last persisted state.

| State | Description | Transitions allowed |
|---|---|---|
| `DISABLED` | Engine off, no orders sent | → `PAPER` or `LIVE` (operator only) |
| `PAPER` | Paper trading active (OANDA practice account) | → `LIVE` (operator, after 30-day gate) · → `LOCKED` (kill switch / circuit breaker) |
| `LIVE` | Live capital trading active | → `LOCKED` (kill switch / circuit breaker) |
| `LOCKED` | All positions flat, engine halted | → `DISABLED` or `PAPER` (operator only, manual DB update + service restart) |

`LOCKED` is a terminal state that **cannot be exited by any automated process**. Only a deliberate operator action (update DB row + restart service) clears it.

---

## 2. Emergency Kill Switch

### 2.1 What it does

When activated, the kill switch:

1. Sets system state to `LOCKED` in the DB (first, before any order attempt)
2. Sends market-close orders for every open position via OANDA API
3. Waits up to 3 seconds for fill confirmations
4. Logs the outcome of each close attempt (filled / timeout / rejected)
5. Fires an alert notification regardless of close success/failure
6. Blocks any further order submission for the session

### 2.2 Trigger paths

The kill switch can be activated via two independent paths — both call the same internal `halt_engine()` function:

| Path | Mechanism | Auth |
|---|---|---|
| **UI button** | `POST /api/trading/kill` — dedicated endpoint, JWT required | Authenticated operator |
| **Automatic** | Internal call from circuit breaker logic (see § 3) | N/A — internal |

**Manual fallback (server unreachable):** OANDA practice dashboard has a native "Close All" button. This must be documented and accessible regardless of platform status. It does not set the DB state to `LOCKED` — operator must do that manually after.

### 2.3 API endpoint

```
POST /api/trading/kill
Authorization: Bearer <jwt>
Body: { "reason": "string" }   // operator-supplied reason, stored in audit log
```

Response (within 3 s):
```json
{
  "state": "LOCKED",
  "positions_closed": 4,
  "positions_failed": 1,
  "failed_details": [{ "instrument": "GBP_USD", "error": "timeout" }],
  "locked_at": "2026-04-15T14:32:01Z",
  "triggered_by": "operator",
  "reason": "Unexpected NFP spike"
}
```

HTTP 200 is returned even if some close orders failed — the engine is locked regardless. The caller must inspect `positions_failed`.

### 2.4 < 3 second SLA

OANDA's REST API latency to the practice endpoint is typically < 300 ms per order. With up to 6 pairs, sequential close calls stay well within 3 s. Implementation:

- Fire all close orders concurrently via `asyncio.gather`
- Set a 2.5 s timeout per order (leaves 500 ms for DB write + alert dispatch)
- Any order that times out is logged as `failed` — engine still locks

### 2.5 UI — Kill Switch button

- Fixed position in the top nav bar, always visible when state is `PAPER` or `LIVE`
- Red background, high-contrast label: **KILL SWITCH**
- Single click opens a confirmation modal:
  - Displays current open positions and unrealized P&L
  - Text field for reason (required)
  - "CONFIRM HALT" button — red, no hover delay
- Modal is intentionally not dismissible by clicking outside (forces deliberate cancel)
- After activation: nav bar shows `SYSTEM LOCKED` badge; Kill Switch button is replaced by a locked-state indicator

---

## 3. Automatic Circuit Breakers

Circuit breakers fire `halt_engine()` automatically when risk thresholds are breached. All thresholds are configurable via the Settings page and stored in the DB — not hardcoded.

### 3.1 Breakers

| Breaker | Default threshold | Logic |
|---|---|---|
| **Max daily drawdown** | 3% of account equity | Halt if unrealized + realized loss since midnight UTC exceeds threshold |
| **Max consecutive losses** | 5 trades | Halt after N losing trades in a row (resets at midnight UTC) |
| **Max open drawdown** | 5% of account equity | Halt if any single open position's unrealized loss exceeds threshold |
| **Position size anomaly** | 2× configured max | Halt if OANDA reports an open position larger than 2× `max_size_units` from the SIR |
| **OANDA API error storm** | 3 errors in 60 s | Halt if order submission fails 3 times in any 60-second window |

### 3.2 Breaker behavior

- Each breaker evaluates on every position/order event and on a 10-second polling heartbeat
- When a breaker fires: logs which breaker triggered, current metric value vs threshold, then calls `halt_engine(reason="circuit_breaker:{name}")`
- Breakers are checked independently — first to fire wins; remaining are not evaluated

### 3.3 Configuring thresholds

Settings page (`/settings`) → **Risk Controls** section:

```
Max daily drawdown:       [3.0] %
Max consecutive losses:   [5]   trades
Max open drawdown:        [5.0] %
OANDA error storm:        [3]   errors / [60] sec
```

Changes write to `risk_settings` table immediately; breaker logic reads from DB (not in-memory cache) so changes take effect without a restart.

---

## 4. Halt Procedure (shared code path)

```python
async def halt_engine(triggered_by: str, reason: str, user_id: int | None = None):
    # 1. Persist LOCKED state first — before touching OANDA
    await db.execute(
        "UPDATE system_state SET state='LOCKED', locked_at=now(), "
        "locked_by=$1, lock_reason=$2 WHERE id=1",
        triggered_by, reason
    )

    # 2. Fetch all open positions from OANDA
    positions = await oanda.get_open_positions()

    # 3. Fire close orders concurrently, 2.5s timeout each
    results = await asyncio.gather(
        *[oanda.close_position(p.instrument) for p in positions],
        return_exceptions=True
    )

    # 4. Write audit record for each position attempt
    await write_halt_audit(positions, results, triggered_by, reason)

    # 5. Publish halt event to Redis → SSE → frontend
    await redis.publish("trading:events", json.dumps({
        "type": "HALT",
        "state": "LOCKED",
        "triggered_by": triggered_by,
        "reason": reason,
        "positions_closed": sum(1 for r in results if not isinstance(r, Exception)),
        "positions_failed": sum(1 for r in results if isinstance(r, Exception)),
    }))

    # 6. Fire alert notification (email + optional Telegram)
    await send_halt_alert(triggered_by, reason, positions, results)
```

---

## 5. Alerting

Every halt — manual or automatic — fires an alert via all configured channels. Alerts are non-blocking (sent after DB write, before returning the API response).

| Channel | Trigger | Content |
|---|---|---|
| **Email** | Every halt | State, trigger source, reason, positions closed/failed, unrealized P&L at halt time |
| **Telegram bot** (optional) | Every halt | Same as email, condensed to one message |
| **In-app SSE** | Every halt + every circuit breaker evaluation | Real-time badge update in the UI |

Alert channel config stored in Doppler: `ALERT_EMAIL`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`.  
If a channel is not configured, it is silently skipped — no error.

---

## 6. Database Schema

### `system_state`
```sql
CREATE TABLE system_state (
    id          INT PRIMARY KEY DEFAULT 1,   -- singleton row
    state       VARCHAR(10) NOT NULL DEFAULT 'DISABLED',
                CHECK (state IN ('DISABLED','PAPER','LIVE','LOCKED')),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    locked_at   TIMESTAMPTZ,
    locked_by   TEXT,        -- 'operator' | 'circuit_breaker:max_daily_drawdown' | etc.
    lock_reason TEXT
);
INSERT INTO system_state (id, state) VALUES (1, 'DISABLED')
    ON CONFLICT DO NOTHING;
```

### `halt_audit`
```sql
CREATE TABLE halt_audit (
    id              SERIAL PRIMARY KEY,
    halted_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    triggered_by    TEXT NOT NULL,
    reason          TEXT NOT NULL,
    positions_json  JSONB NOT NULL,   -- snapshot of open positions at halt time
    close_results   JSONB NOT NULL,   -- per-position: filled | timeout | rejected
    account_equity  NUMERIC(18,5),    -- OANDA account equity at halt time
    unrealized_pnl  NUMERIC(18,5)     -- total unrealized P&L at halt time
);
```

### `risk_settings`
```sql
CREATE TABLE risk_settings (
    id                          INT PRIMARY KEY DEFAULT 1,
    max_daily_drawdown_pct      NUMERIC(5,2) NOT NULL DEFAULT 3.0,
    max_consecutive_losses      INT          NOT NULL DEFAULT 5,
    max_open_drawdown_pct       NUMERIC(5,2) NOT NULL DEFAULT 5.0,
    position_size_anomaly_mult  NUMERIC(5,2) NOT NULL DEFAULT 2.0,
    error_storm_count           INT          NOT NULL DEFAULT 3,
    error_storm_window_sec      INT          NOT NULL DEFAULT 60,
    updated_at                  TIMESTAMPTZ  NOT NULL DEFAULT now()
);
INSERT INTO risk_settings (id) VALUES (1) ON CONFLICT DO NOTHING;
```

---

## 7. Backend — New Files & Changes

| File | Change |
|---|---|
| `backend/routers/trading.py` | Add `POST /api/trading/kill` endpoint |
| `backend/engine/risk.py` | New — circuit breaker evaluation loop, `halt_engine()` |
| `backend/engine/oanda.py` | New — OANDA API client (positions, close, account equity) |
| `backend/tasks/risk_monitor.py` | New — Celery beat task: 10-second polling heartbeat |
| `backend/routers/settings.py` | Add risk settings read/write endpoints |

---

## 8. Frontend — New Files & Changes

| File | Change |
|---|---|
| `src/components/KillSwitchButton.tsx` | Fixed-position nav button + confirmation modal |
| `src/components/SystemStateBadge.tsx` | Nav badge showing current state (`PAPER` / `LIVE` / `LOCKED`) |
| `src/app/live/page.tsx` | Live trading dashboard: positions table, P&L, risk metrics, halt history |
| `src/app/settings/page.tsx` | Add Risk Controls section with breaker threshold inputs |

---

## 9. Phase 4 Gate Criteria (additions)

In addition to the existing "30-day paper trading, zero uncaught errors" gate, Phase 4 is not complete until:

- [ ] Kill switch fires and locks state in < 3 seconds on paper account (verified in staging)
- [ ] All 5 circuit breakers trigger correctly under simulated conditions
- [ ] System restarts in `LOCKED` state after a forced container restart while locked
- [ ] Halt audit log is populated correctly for both manual and automatic halts
- [ ] Alert email is received within 10 seconds of a test halt
- [ ] Manual OANDA fallback procedure is documented and tested independently of the platform

---

## 10. Out of Scope (Phase 4)

- Partial position reduction (the halt always closes 100% of each position)
- Per-strategy kill switches (halt is account-wide)
- Automatic re-enable after a cool-down period (locked state is always manual-recovery only)
- Multi-account support
