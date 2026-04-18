# ML Signal Engine — Feature Spec

**Status:** Planned  
**Phase:** 5 (after Phase 4 Live Trading is proven working)  
**Complexity:** High — new infrastructure, model lifecycle, training pipeline  
**Depends on:** Phase 4 live trading complete, Indicator Lab (feature definitions), 5 years OHLCV data

---

## Purpose

Replace (or augment) the rule-based SIR entry signal with a trained ML model. The model takes
computed indicator features as input and outputs a structured prediction: signal direction,
confidence, and suggested SL/TP levels. The same model runs identically in the backtester and
the live engine — zero behavioural divergence between historical simulation and live execution.

This is NOT a replacement for the Co-Pilot or the SIR system. SIR strategies remain the primary
interface. The ML engine is an additional signal generation method, selectable per strategy.

---

## Core Principle

```
                    ┌────────────────────────┐
                    │     Feature Engine     │
                    │  (engine/indicators.py)│  ← already exists, unchanged
                    └───────────┬────────────┘
                                │
                    ┌───────────▼────────────┐
                    │      ML Engine         │
                    │  (ml/inference.py)     │  ← new, single source of truth
                    └──────────┬─────────────┘
                               │
              ┌────────────────┴────────────────┐
              ▼                                  ▼
   ┌──────────────────┐               ┌──────────────────┐
   │   Backtester     │               │   Live Engine    │
   │  (engine/runner) │               │  (live/engine)   │
   └──────────────────┘               └──────────────────┘
```

The ML engine is a **pure function**: `predict(feature_row) → MLSignal`. No side effects, no I/O.
Both consumers call it the same way.

---

## Standardised Output Format

All ML model predictions return this schema. It NEVER changes between backtest and live:

```python
@dataclass
class MLSignal:
    signal: Literal["BUY", "SELL", "HOLD"]
    confidence: float          # 0.0 – 1.0
    sl_pips: float | None      # suggested stop loss in pips
    tp_pips: float | None      # suggested take profit in pips
    feature_importance: dict   # top-5 features that drove this signal
    model_version: str         # e.g. "eurusd_1h_lgbm_v3"
```

Minimum confidence threshold to act: **0.60** (configurable per strategy in SIR extension).
Below threshold → `HOLD` regardless of `signal` field.

---

## ML Model Choice

**Primary: LightGBM** (gradient boosted trees on tabular features)

Reasons over PyTorch/deep learning for forex tabular data:
- Trains in minutes on 5 years of 1H candles (~31k rows per pair)
- No GPU required
- Resistant to overfitting on small tabular datasets (vs deep learning)
- Fully interpretable via SHAP feature importance
- Inference is microseconds — no latency concern
- Production-proven in quant finance

**Secondary (future):** LSTM or Transformer on raw OHLCV sequences — only if LightGBM proves
insufficient. Do not build this first.

---

## Feature Set (Per Model Input Row)

Each row is one closed candle. Features are computed by `engine/indicators.py` (unchanged):

### Price-derived
- `close`, `high`, `low`, `open`
- `body_size` = `abs(close - open) / open`
- `upper_wick` = `(high - max(open, close)) / open`
- `lower_wick` = `(min(open, close) - low) / open`

### Trend
- `ema20`, `ema50`, `ema200`
- `price_vs_ema20` = `(close - ema20) / ema20`
- `ema20_vs_ema50` = `(ema20 - ema50) / ema50`
- `ema50_vs_ema200` = `(ema50 - ema200) / ema200`

### Momentum
- `rsi14`
- `rsi14_change` = `rsi14 - rsi14_lag1`
- `macd_line`, `macd_signal`, `macd_hist`

### Volatility
- `atr14`
- `bb_width` = `(bb_upper - bb_lower) / bb_mid`
- `close_vs_bb_upper` = `(close - bb_upper) / atr14`

### Strength
- `adx14`

### Calendar
- `hour_of_day` (0–23)
- `day_of_week` (0–4, Mon–Fri)
- `is_london_session` (bool)
- `is_ny_session` (bool)

### Lookahead label (training only, never used in inference)
- `label`: `BUY` if `close[+5] > close[0] + atr14 * 1.0`, `SELL` if below, else `HOLD`
- The `+5` horizon and `atr14` multiplier are tunable hyperparameters

---

## Model Registry

### New DB table: `ml_models`

```sql
CREATE TABLE ml_models (
    id          SERIAL PRIMARY KEY,
    model_id    VARCHAR(100) UNIQUE NOT NULL,   -- e.g. "eurusd_1h_lgbm_v3"
    pair        VARCHAR(10)  NOT NULL,
    timeframe   VARCHAR(5)   NOT NULL,
    algorithm   VARCHAR(20)  NOT NULL,          -- "lgbm", "lstm"
    version     INT          NOT NULL,
    trained_at  TIMESTAMPTZ  NOT NULL,
    metrics     JSONB,                           -- val accuracy, precision, recall, sharpe on holdout
    is_active   BOOLEAN      DEFAULT FALSE,
    artifact_path VARCHAR(500)                   -- path inside container or object store
);
```

Only one model per (pair, timeframe) can have `is_active = TRUE`.

### Model storage

Trained models serialised to `/app/ml_models/{model_id}.pkl` (LightGBM `Booster.save_model()`).
Loaded once at FastAPI startup into a module-level cache dict keyed by `model_id`.
Re-loaded on `POST /api/ml/models/{id}/activate` without restarting the server.

---

## Training Pipeline

### New file: `backend/ml/trainer.py`

Not a web endpoint — a CLI script run manually or via Celery task.

```
python backend/ml/trainer.py \
  --pair EURUSD \
  --timeframe 1H \
  --train-from 2021-04-01 \
  --train-to   2025-01-01 \
  --val-from   2025-01-01 \
  --val-to     2026-01-01
```

Steps:
1. Fetch OHLCV from TimescaleDB for the full window + 300-bar warmup
2. Compute all features via `engine/indicators.py`
3. Generate labels with configurable horizon + ATR multiplier
4. Train/val split (NO random split — always time-based to prevent leakage)
5. Train LightGBM with early stopping on validation loss
6. Evaluate: accuracy, precision, recall per class, Sharpe ratio on val set using signal-only trades
7. Save model artifact + insert row into `ml_models` (is_active=False)
8. Print evaluation report

**Critical:** The train/val split is ALWAYS chronological. Never shuffle. Shuffled splits inflate
accuracy by ~15–20% on financial time series due to autocorrelation leakage.

### Hyperparameters (starting point)

```python
LGBM_PARAMS = {
    "objective":       "multiclass",
    "num_class":       3,          # BUY, SELL, HOLD
    "learning_rate":   0.05,
    "num_leaves":      31,
    "min_data_in_leaf": 100,       # prevents overfit on forex noise
    "feature_fraction": 0.8,
    "bagging_fraction": 0.8,
    "bagging_freq":    5,
    "n_estimators":    1000,       # stopped early by validation
}
```

---

## Inference Layer

### New file: `backend/ml/inference.py`

```python
class MLEngine:
    def __init__(self):
        self._models: dict[str, lgb.Booster] = {}

    def load(self, model_id: str, path: str) -> None:
        self._models[model_id] = lgb.Booster(model_file=path)

    def predict(self, model_id: str, feature_row: dict) -> MLSignal:
        booster = self._models[model_id]
        X = _build_feature_vector(feature_row)  # deterministic, no randomness
        proba = booster.predict([X])[0]          # shape: (3,) — BUY, SELL, HOLD
        signal_idx = proba.argmax()
        confidence = proba[signal_idx]
        ...
        return MLSignal(signal=..., confidence=confidence, ...)
```

This class is instantiated once as a FastAPI app-state singleton (same pattern as DB pool).
The Celery worker gets its own instance — no shared memory across processes.

---

## Backtester Integration

### SIR extension: `ml_signal` entry condition

Existing SIR entry conditions use rule-based logic. ML adds a new condition type:

```json
{
  "entry_conditions": [
    {
      "type": "ml_signal",
      "model_id": "eurusd_1h_lgbm_v3",
      "signal": "BUY",
      "min_confidence": 0.65
    }
  ]
}
```

`engine/parser.py` recognises `type: "ml_signal"` and calls `MLEngine.predict()` per candle
instead of evaluating a rule. Can be combined with rule-based conditions (AND logic):

```json
{
  "entry_conditions": [
    { "type": "ml_signal", "model_id": "...", "signal": "BUY", "min_confidence": 0.65 },
    { "indicator": "ADX", "period": 14, "operator": ">", "value": 25 }
  ]
}
```

### Backtester performance concern

LightGBM inference on 31k rows of 1H candles: ~50–200ms total (not per candle). Acceptable.
If 1m candles are used (~1.8M rows): ~2–5s. Add a progress note in the UI.

---

## Live Engine Integration

`live/engine.py` (Phase 4) calls `MLEngine.predict()` on each completed bar — same call as
the backtester. The only difference is the candle ring buffer is used instead of a DataFrame.

The confidence threshold gate:
```python
signal = ml_engine.predict(model_id, feature_row)
if signal.confidence < strategy.ml_min_confidence:
    continue  # skip — don't execute
```

---

## API Endpoints

New file: `backend/routers/ml.py`, prefix `/api/ml`

| Endpoint | Purpose |
|---|---|
| `GET /api/ml/models` | List all models in registry with metrics |
| `GET /api/ml/models/{id}` | Model detail + feature importance + val metrics |
| `POST /api/ml/models/{id}/activate` | Set as active for (pair, timeframe); deactivates previous |
| `POST /api/ml/train` | Enqueue a Celery training task (long-running) |
| `GET /api/ml/train/{job_id}/status` | Training job progress (epochs, current val loss) |
| `POST /api/ml/predict` | Single-row inference — for Indicator Lab integration |
| `DELETE /api/ml/models/{id}` | Remove from registry (only if not active) |

---

## Frontend: ML Model Manager

New section in the **Settings** page (not a separate tab):

```
Settings
  ├── AI Model
  ├── Trading
  └── ML Models   ← new section
```

### ML Models section

- Table of trained models: pair, timeframe, algorithm, version, trained date, val Sharpe, status (Active / Inactive)
- [Activate] button — sets as active for that pair+TF
- [Train New] button → opens training config modal:
  - Pair, timeframe, train window, val window, label horizon, confidence threshold
  - Submits to `POST /api/ml/train`
- Training job progress bar (polls `GET /api/ml/train/{job_id}/status`)
- Feature importance chart (horizontal bar, top 10 features, SHAP values)

---

## Indicator Lab Integration

When a model is active for the selected pair+timeframe, Indicator Lab shows a toggle:
**"Use ML signals"** — when enabled, overlays ML BUY/SELL markers on the chart in addition to
rule-based condition markers. Confidence shown as marker opacity (low confidence = faded).

Claude in the AI Panel can see the ML signal count + confidence distribution in the visible
window and comment on it.

---

## Safety Layer

Identical to the architecture doc's recommendations:

```python
# Applied in live/engine.py before any order execution
if signal.confidence < strategy.ml_min_confidence:
    skip  # below confidence threshold
if daily_trade_count >= strategy.max_trades_per_day:
    skip  # max daily trades reached
if current_drawdown >= strategy.max_drawdown_pct:
    skip  # drawdown kill switch
```

All three limits stored on the strategy record / SIR extension. Defaults:
- `ml_min_confidence`: 0.60
- `max_trades_per_day`: 5
- `max_drawdown_pct`: 5.0%

---

## Build Order

### Step 1 — Feature pipeline + training script
- `backend/ml/features.py` — feature computation wrapper over `engine/indicators.py`
- `backend/ml/trainer.py` — CLI training script
- `db/migrations/0xx_ml_models.sql` — model registry table
- Validate: train on EURUSD 1H, check val metrics, inspect feature importance

### Step 2 — Inference layer
- `backend/ml/inference.py` — `MLEngine` class
- `backend/core/app_state.py` — load active models at FastAPI startup
- `POST /api/ml/predict` endpoint — manual testing

### Step 3 — Backtester integration
- `engine/parser.py` — handle `type: "ml_signal"` condition
- `engine/runner.py` — pass `MLEngine` instance into runner
- Validate: run a backtest with an ML-condition SIR, compare signals to manual prediction

### Step 4 — Model management API + UI
- `routers/ml.py` — full CRUD + train endpoint
- Settings page ML Models section
- Training job progress

### Step 5 — Live engine integration
- `live/engine.py` — wire `MLEngine.predict()` on each bar close
- End-to-end test: shadow mode signal log shows ML-based signals

### Step 6 — Indicator Lab integration
- ML signal overlay toggle in Lab chart
- Claude AI Panel aware of ML signal distribution

Estimated PRs: 8–10

---

## DB migration sequence

| Migration | Contents |
|---|---|
| `0xx_ml_models.sql` | `ml_models` registry table |
| `0xx_ml_predictions_log.sql` | Optional: log every live inference for drift monitoring |

---

## Key risks and mitigations

| Risk | Mitigation |
|---|---|
| Overfitting to historical data | Time-based train/val split; min 2-year holdout; check Sharpe on holdout not just accuracy |
| Backtest/live feature mismatch | Single `features.py` module; no separate feature calculation paths |
| Model staleness | `trained_at` tracked; alert if model > 90 days old on active use |
| Inference latency (1m TF) | Benchmark before enabling on 1m; LightGBM is fast but 1.8M rows needs profiling |
| Confidence miscalibration | LightGBM multi-class probabilities can be overconfident; consider Platt scaling |

---

## Out of scope (v1)

- Deep learning models (LSTM, Transformer) — add after LightGBM baseline is proven
- Automated retraining on schedule — manual retrain + activate for now
- Multi-pair ensemble models — one model per (pair, timeframe) only
- Walk-forward optimisation — validate manually; automate in v2
- Real-time feature drift monitoring — log predictions, analyse offline
