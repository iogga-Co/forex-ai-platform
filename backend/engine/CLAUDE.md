# Backend Engine — SIR Schema & Patterns

## Strategy Intermediate Representation (SIR)

All strategies are stored as JSON in `ir_json` / `strategy_ir` columns. Schema defined in `backend/engine/sir.py`:

```json
{
  "entry_conditions": [
    { "indicator": "EMA", "period": 20, "operator": "price_above" },
    { "indicator": "RSI", "period": 14, "operator": ">", "value": 50 }
  ],
  "exit_conditions": {
    "stop_loss":   { "type": "atr", "period": 14, "multiplier": 1.5 },
    "take_profit": { "type": "atr", "period": 14, "multiplier": 3.0 }
  },
  "filters": { "exclude_days": [], "session": "all" },
  "position_sizing": { "risk_per_trade_pct": 1.0, "max_size_units": 100000 }
}
```

Supported indicators: `RSI`, `EMA`, `SMA`, `MACD`, `BB`, `ATR`, `ADX`, `STOCH`

Special parameter names (not `period`):
- MACD → `fast`, `slow`, `signal_period`
- BB → `std_dev`
- STOCH → `k_smooth`, `d_period`

---

## SIR extensions (Phase 3.6)

`exit_conditions` now supports three optional fields — backwards-compatible (existing strategies default to `stops_only` / no trailing):

```json
{
  "exit_conditions": {
    "stop_loss":   { "type": "atr", "period": 14, "multiplier": 1.5 },
    "take_profit": { "type": "atr", "period": 14, "multiplier": 3.0 },
    "exit_mode":   "first",
    "indicator_exits": [
      { "indicator": "RSI", "period": 14, "operator": "<", "value": 30 }
    ],
    "trailing_stop": {
      "enabled": true, "type": "atr", "period": 14,
      "multiplier": 1.5, "activation_multiplier": 1.0
    }
  }
}
```

`exit_mode` values: `"stops_only"` (default) | `"first"` (any condition closes) | `"all"` (conservative fallback = stops_only).

Trailing stop uses vectorbt `sl_trail=True` — trailing starts immediately from entry (activation threshold requires custom `adjust_sl_func_nb` in vectorbt 0.26.2; deferred).

---

## SIR extensions (Phase 5.3) — ExecutionConfig

Optional `execution` block on the SIR controls how live orders are placed. Fully backwards-compatible — omitting the field defaults to `mode: "market"`.

```json
{
  "execution": {
    "mode": "market",
    "limit_offset_atr": 0.5,
    "limit_expiry_minutes": 5,
    "twap_slices": 3,
    "twap_interval_minutes": 2,
    "max_spread_pips": 3.0
  }
}
```

`mode` values:
- `"market"` (default) — single market order, immediate fill
- `"limit"` — GTD limit at `close_price ± (limit_offset_atr × atr_value)`; cancelled after `limit_expiry_minutes` if unfilled
- `"twap"` — total units split into `twap_slices` equal market orders, `twap_interval_minutes` apart

`max_spread_pips` — executor skips the signal when the signal-time spread exceeds this value. Uses `spread_pips` field in the signal payload (included by `engine.py` from live tick data).

Pydantic model: `ExecutionConfig` in `engine/sir.py`. Field on `StrategyIR`: `execution: ExecutionConfig = Field(default_factory=ExecutionConfig)`.

---

## Optimization iterations — `strategy_ir` field

`GET /api/optimization/runs/{run_id}/iterations` returns `strategy_ir` (full SIR JSON) for each iteration. Used by the frontend to save an iteration as a new strategy.

`DELETE /api/optimization/runs/{run_id}/iterations/{iteration_number}` — deletes a single iteration (1-based). Used by the batch delete flow on the Optimization page.

`strategy_ir` arrives as a Python dict (decoded by asyncpg JSONB codec) — no `json.loads` needed in the router.

On the frontend it may be a plain object or a JSON string depending on caching; always handle both:
```ts
typeof rawIr === "string" ? JSON.parse(rawIr) : rawIr
```
