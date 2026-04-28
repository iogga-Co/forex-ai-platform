# Backend Live — Trading Architecture

## Phase 4 modules (`backend/live/`)

### `oanda.py` — async OANDA v20 client (httpx)
- `stream_prices(pairs)` — async generator yielding `{"type":"tick","pair","bid","ask","time"}` or `{"type":"heartbeat"}`
- `place_market_order(instrument, units, sl_price, tp_price)`
- `close_position(instrument)`, `get_open_positions()`, `get_account_summary()`
- Constructor accepts `base_url`/`stream_url` for testing against a mock

OANDA instrument format: `EUR_USD` (underscore). Internal format: `EURUSD` (no separator). Conversion handled inside `oanda.py`.

Practice URLs:
- REST: `https://api-fxpractice.oanda.com`
- Stream: `https://stream-fxpractice.oanda.com`

### `feed.py` — asyncio task (runs in trading-service, NOT FastAPI)
- Streams all 6 pairs from OANDA, publishes ticks to Redis `ticks:{pair}` channels
- Always runs regardless of `LIVE_TRADING_ENABLED` — price ticker needs it
- Exponential backoff reconnect on failure (max 60s)
- Heartbeat staleness check: if no OANDA heartbeat for >30s, raises `RuntimeError` to trigger reconnect

WebSocket relay: `/ws/prices/{pair}` in `routers/ws.py` — no auth, relays `ticks:{pair}` from Redis to browser.

### `bars.py` — `BarBuilder(pair, timeframe)`
- `update(bid, ask, tick_time)` — returns a completed `OHLCVBar` when a bar boundary is crossed (first tick of the next bar closes the previous)
- Ring buffer `deque(maxlen=500)` per pair+TF stores completed bars in memory
- `to_dataframe()` → float64 DataFrame for indicator computation
- Completed bars also persisted to `ohlcv_candles` (ON CONFLICT DO NOTHING)

### `engine.py` — `run_engine(stop_event, pool)`
- One asyncio worker per pair; subscribes to Redis `ticks:{pair}`, drives BarBuilders for 1m and 1H
- On each completed bar: evaluates all active strategies' entry conditions using `engine/indicators.py`
- `LIVE_TRADING_ENABLED=false` → signal published to Redis `live:signals` with `shadow=true`, no orders placed
- Capped log in Redis list `live:signal_log` (last 50) for page-load history replay
- Strategies reloaded from DB every 5 min
- **Phase 5.3:** each signal now includes `spread_pips` (live spread at signal time) and `close_price` (bar close, used for limit entry offset calculation)

Signal payload:
```json
{
  "pair": "EURUSD", "timeframe": "1H", "direction": "long",
  "strategy_id": "...", "strategy_name": "...",
  "shadow": false, "atr_value": 0.00123,
  "spread_pips": 0.8, "close_price": 1.08450
}
```

WebSocket: `/ws/signals` — on connect replays `live:signal_log` history, then streams `live:signals` pub/sub. No auth.

---

## Phase 5.1 — Trading service decomposition

`backend/trading_service.py` — standalone asyncio process. Feed, engine, and executor run here, **not** in the FastAPI process. FastAPI lifespan now only manages the DB pool and Redis bridge task.

`get_executor()` / `set_executor()` singleton **no longer exist** — executor runs in the trading-service process.

### Redis channels

| Key / Channel | Direction | Purpose |
|---|---|---|
| `ticks:{pair}` | feed → engine | OANDA tick pub/sub |
| `live:signals` | engine → executor | trade signal pub/sub |
| `live:commands` | web → executor | kill-switch commands |
| `live:cmd_results:{request_id}` | executor → web | kill-switch response (Redis list, 30s TTL) |
| `live:account_balance` | executor → web | balance cache (30s TTL, written each poll) |
| `live:heartbeat` | trading-service → Docker | health check key (60s TTL, written every 30s) |

### Kill-switch flow

Router publishes to `live:commands` → executor handles it → pushes result to `live:cmd_results:{request_id}` → router `blpop`s with 10s timeout.

---

## Phase 5.3 — Advanced Execution

### `spread.py` — `SpreadTracker`
- Rolling 20-tick median spread per pair in pips
- `update(pair, bid, ask)` — call on every tick
- `current_pips(pair)` — median spread; returns 0.0 on cold start (no data)
- `is_acceptable(pair, max_pips)` — True when spread ≤ max_pips; True on cold start (don't block first order)
- Uses `core/instruments.py` `get_pip_size()` for correct JPY pip scaling

### `twap.py` — `execute_twap(oanda, instrument, total_units, slices, interval_sec)`
- Splits `total_units` into `slices` equal market orders, waiting `interval_sec` between each
- Last slice absorbs integer-division remainder so total is always exact
- Continues on slice failure (logs error, keeps going)
- Returns list of OANDA response dicts; failed slices have an `"error"` key

### `executor.py` — execution mode routing (Phase 5.3 additions)

**Spread gate** — `_handle_signal()` reads `spread_pips` from the signal, compares to `ir.execution.max_spread_pips`. If exceeded, signal is skipped with a log line. Pass-through when `spread_pips` absent (backwards compat).

**Execution modes** — routed from `ir.execution.mode`:
- `"market"` → `_handle_market()` — single `place_market_order`; updates to `filled` immediately
- `"limit"` → `_handle_limit()` — `place_limit_order` at `close_price ± (limit_offset_atr × atr_value)`; fires `_monitor_limit_expiry` background task that cancels after `limit_expiry_minutes * 60` seconds
- `"twap"` → `_handle_twap()` — delegates to `execute_twap()`; marks `filled` if ≥1 slice succeeds

**`_insert_order` now stores** `pair`, `execution_mode`, `spread_pips` (migration 023 adds these columns).

### `oanda.py` — new methods (Phase 5.3)
- `place_limit_order(instrument, units, price, expiry_seconds, sl_price, tp_price)` — GTD LIMIT order
- `cancel_order(order_id)` — cancel a pending order by OANDA order ID

### DB migration 023
`db/migrations/023_live_orders_execution.sql` adds to `live_orders`:
- `pair VARCHAR(10)` — fixes missing column referenced by reconciliation
- `execution_mode VARCHAR(20) NOT NULL DEFAULT 'market'`
- `limit_price NUMERIC(18, 8)` — the limit price placed (NULL for market/twap)
- `spread_pips NUMERIC(8, 4)` — spread at signal time for post-trade audit
