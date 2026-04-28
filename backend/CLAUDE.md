# Backend — Core Patterns

Sub-files for specialist areas:
- `engine/CLAUDE.md` — SIR schema + extensions
- `live/CLAUDE.md` — live trading architecture (Phase 4 + 5.1)
- `ai/CLAUDE.md` — AI model routing, diagnosis, lab agent
- `tasks/CLAUDE.md` — G-Optimize ConfigSampler + RAG injection

---

## asyncpg gotchas

### NUMERIC columns → float

asyncpg returns `NUMERIC`/`DECIMAL` as Python `Decimal`. FastAPI serialises `Decimal` as a string — breaks frontend `.toFixed()`. Always cast before returning:

```python
def _f(v): return float(v) if v is not None else None
```

Apply `_f()` to **every** NUMERIC column in every endpoint response.

### JSONB codec

`core/db.py` registers a `json.loads` codec for JSONB. Columns like `strategy_ir` and `ir_json` arrive as Python dicts — **no** manual `json.loads()` needed in route handlers.

### timedelta columns

Duration arithmetic (e.g. `exit_time - entry_time`) returns a Python `timedelta`. Convert:

```python
def _dur_min(t): return (t["exit_time"] - t["entry_time"]).total_seconds() / 60
```

---

## SSE auth

SSE endpoints use `get_current_user_sse` (token via query param `?token=`), **not** the standard Bearer header dependency. Pattern in `routers/optimization.py`.

---

## Celery task queues

- Backtest tasks → default queue
- Optimization tasks → `optimization` queue (separate worker)
- G-Optimize tasks → `g_optimize` queue (dedicated worker — prevents long runs from blocking interactive backtests)

---

## pgvector queries

PostgreSQL cannot infer the type of unreferenced `$N` parameters. If multiple queries share a params array and some `$N` indices are skipped, split into separate param arrays — one per query.

---

## Settings.for_testing() (Phase 5.2.12)

`core/config.py` — classmethod for unit tests that don't need real env vars:

```python
s = Settings.for_testing(live_trading_enabled=True)
```

---

## MFA — TOTP for kill-switch (Phase 5.0.4)

- `POST /api/auth/mfa/setup` — generates TOTP secret, returns `{secret, otpauth_uri}`
- `POST /api/auth/mfa/verify` — validates TOTP code, returns `{mfa_token}` (15-min JWT, type=`"mfa"`)
- `GET /api/auth/mfa/status` — returns `{configured, enabled}`

`require_mfa` FastAPI dependency (`core/auth.py`) — reads `X-MFA-Token` header, validates JWT type=`"mfa"`. Applied to `POST /api/trading/kill-switch`. DB table: `operator_mfa` (migration 022).

---

## InstrumentRegistry (Phase 5.0.3)

`backend/core/instruments.py` — `get_pip_size(symbol: str) -> float`.

Normalises `"EUR/USD"` → `"EURUSD"`, case-insensitive. Falls back to `0.0001` for unknown symbols. Used in `engine/parser.py` and `live/executor.py`. **Do not** add `"JPY" in symbol` string checks anywhere — use `get_pip_size()`.

---

## Doppler secrets

Secrets injected at runtime via `doppler run --`. Never hardcode secrets. Configs: `development` (local), `staging`, `production` — all three must be updated when adding new secrets.
