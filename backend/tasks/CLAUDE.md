# Backend Tasks — G-Optimize

## ConfigSampler + RAG injection

`backend/tasks/g_optimize.py` — `ConfigSampler.sample()` generates random valid SIR dicts from `entry_config`/`exit_config` JSONB blobs stored on `g_optimize_runs`.

### `entry_config` format
```json
{
  "max_conditions": 3,
  "conditions": [
    { "indicator": "RSI", "period_min": 10, "period_max": 20, "period_step": 5,
      "operator": ">", "value_min": 40, "value_max": 70 }
  ]
}
```

### `exit_config` format
```json
{
  "exit_mode": "stops_only",
  "indicator_exits": [],
  "sl": { "type": "atr", "period": 14, "multiplier_min": 1.0, "multiplier_max": 3.0, "multiplier_step": 0.5 },
  "tp": { "type": "atr", "period": 14, "multiplier_min": 1.5, "multiplier_max": 5.0, "multiplier_step": 0.5 },
  "trailing": { "enabled": false },
  "rr_floor": 1.5
}
```

### Sampler constraints enforced
- MACD: `fast < slow`
- R:R floor: TP ≥ `rr_floor × SL`
- All parameter values within min/max bounds

### Startup recovery (`worker_ready` signal)

`_reset_stale_runs` — registered on `celery.signals.worker_ready`. Fires when the g_optimize worker starts; resets any `g_optimize_runs` rows stuck at `status='running'` to `'failed'`. Guards against the common case where a SIGKILL (container restart, `time_limit` hard kill) bypasses Python exception handling and leaves the row permanently running.

- Filtered by `sender.consumer.queues` — only runs when `g_optimize` is in the worker's queue set; backtest/optimization workers are unaffected.
- Swallows all exceptions so a DB blip cannot prevent worker startup.

### RAG injection

`embed_and_inject_rag()` — called for passing strategies:
1. Builds human-readable description
2. Calls Voyage AI embed via `asyncio.run()` (sync Celery context — use `asyncio.run()`, not `await`)
3. Inserts into `strategies` table with `metadata.source="g_optimize"`, stores embedding, sets `backtest_runs.strategy_id`

`POST /api/g-optimize/strategies/{id}/promote` — manual RAG injection for failed strategies; runs in the FastAPI event loop (uses `await voyage_embed()` directly, **not** `asyncio.run()`).

---

---

## RAG backfill task (Phase 5.4)

`backend/tasks/rag_backfill.py` — `backfill_embeddings` Celery task.

Embeds rows that are missing a pgvector embedding:
- `strategies` where `embedding IS NULL AND description IS NOT NULL AND deleted_at IS NULL`
- `backtest_runs` where `embedding IS NULL AND summary_text IS NOT NULL`

Uses `ai/voyage_client.embed_batch()` for efficient batching, psycopg2 for DB updates (same sync pattern as `g_optimize.py`). Triggered via `POST /api/rag/backfill` → 202 + `{job_id}`.

---

## G-Optimize DB schema additions

`backtest_runs` new columns (migrations 018, 019):

| Column | Type | Notes |
|---|---|---|
| `source` | `VARCHAR(20) DEFAULT 'manual'` | `'manual'` \| `'optimization'` \| `'g_optimize'` |
| `g_optimize_run_id` | `UUID` | FK to `g_optimize_runs` (ON DELETE SET NULL) |
| `passed_threshold` | `BOOLEAN` | NULL for manual/optimization rows |
| `sir_json` | `JSONB` | Stores sampled SIR for g_optimize rows |
| `strategy_id` | — | Now **nullable** — g_optimize runs have no strategy row until promoted |
