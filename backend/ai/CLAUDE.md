# Backend AI — Model Routing, Diagnosis & Lab Agent

## RAG retrieval (Phase 5.4)

`backend/ai/retrieval.py` — hybrid RAG: pgvector cosine similarity + BM25 full-text, fused via Reciprocal Rank Fusion.

Key constants:
- `_MIN_RRF_SCORE = 0.015` — rank-1 single-path hits score ≈ 0.0164 and are included (lowered from 0.020 in Phase 5.4 to avoid dropping valid results in sparse strategy DBs)
- `_VECTOR_K = _BM25_K = 5`, `_TOP_N = 6`

Each returned chunk's `metadata` dict includes a `rrf_score` field (rounded to 4 decimal places) from the fused ranking. Used by `routers/copilot.py` to log retrievals to `rag_retrievals`.

New endpoints (`routers/rag.py`, prefix `/api/rag`):

| Endpoint | Purpose |
|---|---|
| `GET /api/rag/coverage` | Embedding counts for strategies/backtest_runs/conversation_turns + 24h retrieval count |
| `POST /api/rag/backfill` | Enqueue Celery backfill task; returns `{job_id}` |

---

## AI model routing

`backend/ai/model_router.py` — single entry point. Dispatches based on model ID prefix:
- `claude-*` → Anthropic
- `gpt-*` → OpenAI
- `gemini-*` → Google

Two public async functions:
- `get_full_response` — used by diagnosis, period analysis
- `stream_chat_copilot` — used by Co-Pilot SSE

Celery tasks use the sync variants of OpenAI/Gemini clients.

Token usage logged to `ai_usage_log` table (migration 015) — model, feature, input/output counts.

---

## AI Diagnosis endpoints (`/api/diagnosis`)

`backend/routers/diagnosis.py`

| Endpoint | Purpose |
|---|---|
| `POST /api/diagnosis/strategy` | Single-strategy weakness analysis — fetches metrics + trades, pre-computes stats, calls Claude, returns up to 3 structured fix suggestions with `ir_patch` objects |
| `POST /api/diagnosis/trades/stats` | Selection vs population trade stats — takes `backtest_run_id` + `trade_ids`; returns win rate, avg PnL/R, duration, MAE/MFE, long/short breakdown, by_hour, by_dow for both selection and full run |
| `POST /api/diagnosis/trades/analyze` | AI pattern analysis — takes pre-computed `stats` dict (from `/trades/stats`); calls `ai/trade_analysis.py` → Claude; returns `{headline, patterns, verdict, recommendation}` |

AI modules:
- `backend/ai/strategy_diagnosis.py` — single-strategy diagnosis prompt
- `backend/ai/trade_analysis.py` — multi-trade pattern analysis prompt
- `backend/ai/period_diagnosis.py` — period + news event analysis

All diagnosis request bodies accept a `model: str` field (default `"claude-sonnet-4-6"`). Frontend sends `model: loadSettings().ai_model`.

**Two-step fetch pattern for trade analysis:** call `/trades/stats` first, render the stats, then call `/trades/analyze` with the stats dict. This avoids sending raw trade data to Claude and produces tighter prompts.

Verdict values: `"structural" | "edge_decay" | "outlier" | "inconclusive"`
Pattern strength values: `"strong" | "moderate" | "weak"`

---

## G-Optimize analyze endpoint

`POST /api/g-optimize/analyze` — Co-Pilot ranking analysis via `ai/g_optimize_agent.py`. Accepts `scope: "checked"|"run"|"all"`. Filters strategies with < 50 trades into `skipped`. Caps at 30 strategies (sorted by Sharpe). Returns `{recommendations, skipped, skipped_reason, strategy_ids}` where `strategy_ids` maps `backtest_run_id → strategy_id` for Co-Pilot navigation.

---

## Indicator Lab AI panel — `lab_agent.py`

`backend/ai/lab_agent.py` — Claude tool-use agent for the right-panel chat.

**Tool:** `set_indicator_config` — Claude calls this to suggest indicator + condition configs. Result emitted as `ir_update` SSE event; text reply emitted as `text` event.

**SSE events:** `{"type": "ir_update", "config": {...}}` → `{"type": "text", "content": "..."}` → `{"type": "done"}`

**Indicator Lab endpoints** (`backend/routers/lab.py`, prefix `/api/lab`):

| Endpoint | Auth | Purpose |
|---|---|---|
| `POST /api/lab/indicators` | None | Compute indicator series (stateless) |
| `POST /api/lab/signals` | None | Compute signal timestamps from conditions |
| `GET /api/lab/indicators/saved` | JWT | List saved indicators for current user |
| `POST /api/lab/indicators/saved` | JWT | Create saved indicator |
| `PUT /api/lab/indicators/saved/{id}` | JWT | Update name / status / config |
| `DELETE /api/lab/indicators/saved/{id}` | JWT | Delete |
| `POST /api/lab/analyze` | SSE | Claude indicator config chat |

`DELETE /api/lab/indicators/saved/{id}` requires `response_model=None` explicitly (FastAPI 204 assertion — `-> None` alone is insufficient in current version).

`POST /api/lab/indicators` response schema is identical to `GET /api/analytics/backtest/{id}/indicators` — frontend chart rendering is reused.

### Anthropic SDK typing

- `block.input` is typed as `object` — use `cast(dict[str, Any], block.input)`
- Tools list needs `# type: ignore[list-item]`
- Messages need `cast(list[MessageParam], ...)`

### Nested f-string caveat

`f"{f' {x[\"k\"]}' if ... else ''}"` is invalid syntax (ruff rejects). Use string concatenation:
```python
f"..." + (f" {x['k']}" if ... else "")
```
