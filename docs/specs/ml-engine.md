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

**Secondary (v2):** BiLSTM / Transformer on OHLCV sequences — see [v2: SSLT Architecture](#v2-sslt-architecture) below.
Build this only after LightGBM baseline is proven in production.

---

## Feature Set (Per Model Input Row)

Each row is one closed candle. Features are computed by `engine/indicators.py` (unchanged):

### Price-derived
- `close`, `high`, `low`, `open`
- `returns` = `close.pct_change()`
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

### Market structure
- `higher_high` = bool — `high > high[−1]`
- `lower_low`   = bool — `low < low[−1]`
- `expansion`   = bool — `range > range.rolling(20).mean()` (current bar is above-average size)

### Structure + liquidity proxies
- `swing_high_dist` = distance from `close` to nearest recent swing high (normalised by ATR)
- `swing_low_dist` = distance from `close` to nearest recent swing low (normalised by ATR)
- `equal_highs` = bool — 2+ recent highs within 0.5 × ATR (potential stop cluster above)
- `equal_lows` = bool — 2+ recent lows within 0.5 × ATR (potential stop cluster below)
- `liq_high_cluster` = `high.rolling(10).apply(lambda x: (abs(x - x.mean()) < 0.0005).sum())` — count of highs clustered near the rolling mean; high value = stacked stops above
- `liq_low_cluster`  = same applied to `low` — stacked stops below
- `wick_spike` = bool — either wick > 2 × body size
- `sweep_high` = bool — `high > high[−1]` AND `close < high[−1]` (pierced prior high, closed back inside — stop-run)
- `sweep_low`  = bool — `low < low[−1]`  AND `close > low[−1]`  (pierced prior low,  closed back inside — stop-run)
- `sweep_strength` = `(high - close) / range` — how aggressively price was rejected at the high (continuous version of `sweep_high`)
- `range_compression` = rolling ATR[5] / ATR[20] — low value = coiling, high = expansion

### Lookahead label (training only, never used in inference)

Outcome-based labeling — measures what actually happened over the next N candles, not a simple
price-vs-price comparison. This better reflects trade viability than a fixed-horizon close delta.

```python
FORWARD_WINDOW = 20      # candles to look ahead (tunable)
TP             = 0.0020  # take-profit as raw price delta (pair-agnostic; ~20 pips on EURUSD 1H)
SL             = 0.0010  # stop-loss  as raw price delta (~10 pips)

# For each candle i:
future   = df.iloc[i+1 : i+FORWARD_WINDOW]
max_up   = future["high"].max()  - close[i]
max_down = close[i] - future["low"].min()

if   max_up   >= TP and max_down < SL:  label = BUY
elif max_down >= TP and max_up   < SL:  label = SELL
else:                                    label = HOLD

# Secondary label: move quality (used for sample weighting)
quality[i] = max(max_up, max_down)
```

`quality` is a continuous value representing how strong the winning side was. It is stored
alongside `label` in the training dataset and used to weight the loss function during training
so the model learns to care more about strong moves than marginal ones (see Training Pipeline).

Using raw price delta (not pip-normalised) keeps the formula pair-agnostic; scale `TP`/`SL` per
pair if needed. `FORWARD_WINDOW`, `TP`, and `SL` are CLI arguments to `trainer.py`; defaults
above suit 1H candles. For 1m, reduce `FORWARD_WINDOW` and `TP`/`SL` proportionally.

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
3. Generate labels with configurable horizon + ATR multiplier; compute `quality` column
4. Train/val split (NO random split — always time-based to prevent leakage)
5. Train LightGBM with early stopping on validation loss, **weighted by `quality`**:
   ```python
   model.fit(X_train, y_train, sample_weight=quality_train, ...)
   ```
6. Evaluate: accuracy, precision, recall per class, Sharpe ratio on val set using signal-only trades
7. Save model artifact + insert row into `ml_models` (is_active=False)
8. Print evaluation report

**Critical:** The train/val split is ALWAYS chronological. Never shuffle. Shuffled splits inflate
accuracy by ~15–20% on financial time series due to autocorrelation leakage.

**Sample weighting:** Weighting by `quality` (move magnitude) focuses the model on setups where
the market made a decisive move. Marginal TP/SL races — where max_up ≈ max_down — contribute
less to the loss. This tends to improve real-money performance more than accuracy metrics suggest
because those marginal trades are the first to fail in live conditions (spread + slippage eats them).

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

---

## v2: SSLT Architecture

**Status:** Planned after LightGBM v1 is proven in production  
**Model name:** State-Space Liquidity Transformer (SSLT)

### Philosophy

Forex operates in state transitions: Accumulation → Manipulation → Expansion → Distribution.
A sequence model can learn these transitions; a single-row LightGBM cannot. SSLT is the natural
upgrade once tabular signals hit their ceiling.

### Input

Sequence of the last 50–200 closed candles. Each timestep carries the same feature set as v1
(all columns above) — no new features needed at this layer.

```python
# shape: (batch, sequence_length=100, features=25)
```

### Architecture

```
Input Sequence (candles × features)
        ↓
Feature Encoder — Dense(64) → ReLU → Dense(64)
        ↓
State Encoder — BiLSTM(hidden=128, layers=2)   # or Transformer Encoder
        ↓
Latent Market State — 128-dim vector
        ↓
Multi-head outputs:
   ├─ Head 1: Regime          — Dense → Softmax(4)  [RANGE, TREND, EXPANSION, REVERSAL]
   ├─ Head 2: Liquidity Event — Dense → Sigmoid      [stop-hunt / sweep probability]
   ├─ Head 3: Direction       — Dense → Softmax(3)  [BUY, SELL, HOLD] + scalar move_pips
   └─ Head 4: Confidence      — Dense → Sigmoid      [signal reliability]
```

Start with BiLSTM; upgrade to Transformer Encoder only if BiLSTM underfits.

**Attention layer** — add `nn.MultiheadAttention` after the BiLSTM output so the model can
focus on key candles (e.g. sweep bars, compression breakouts) rather than treating all 100
timesteps equally:

```python
self.attention = nn.MultiheadAttention(embed_dim=128, num_heads=4, batch_first=True)
# usage: attn_out, _ = self.attention(lstm_out, lstm_out, lstm_out)
```

**Feature gating** — a learned gate applied to the feature encoder output lets the model
suppress irrelevant features dynamically per timestep:

```python
self.gate = nn.Linear(input_size, input_size)
# usage: x = x * torch.sigmoid(self.gate(x))
```

This is particularly useful because regime-relevant features change: volatility features matter
during compression; structure features matter at potential sweep points.

### MLSignal extension for SSLT models

LightGBM models set the new fields to `None` — all existing consumers are unaffected.

```python
@dataclass
class MLSignal:
    signal: Literal["BUY", "SELL", "HOLD"]
    confidence: float
    sl_pips: float | None
    tp_pips: float | None
    feature_importance: dict
    model_version: str
    # v2 fields — None for LightGBM models
    regime: Literal["RANGE", "TREND", "EXPANSION", "REVERSAL"] | None
    liquidity_sweep_prob: float | None
    expected_move_pips: float | None
```

### Decision engine

Raw model outputs are filtered through regime-conditional logic before a trade is issued.
Lives in `live/engine.py` and the backtester runner — not inside the model itself.

```python
if regime == "RANGE" and confidence > 0.70:
    trade = mean_reversion_signal(direction)

elif regime == "TREND" and liquidity_sweep_prob > 0.60 and direction == "BUY":
    trade = continuation_signal(direction)

elif regime == "EXPANSION":
    trade = breakout_signal(direction)

else:
    trade = None  # no trade
```

### Training

Same outcome-based labeling as v1. Additional label columns for training the regime and
liquidity heads are derived from heuristics applied to the historical feature sequences:

- **Regime label** — derived from rolling ATR percentile + EMA slope + range compression
- **Liquidity label** — `equal_highs` / `equal_lows` followed by `wick_spike` within 3 candles

### Loss function

```python
total_loss = (
    direction_loss               # cross-entropy, weight 1.0
  + 0.5 * regime_loss            # cross-entropy
  + 0.5 * liquidity_loss         # binary cross-entropy
  + 0.2 * confidence_loss        # MSE vs realised win rate in batch
)
```

### Inference interface

```python
class LSTMEngine:
    def predict(self, model_id: str, feature_sequence: np.ndarray) -> MLSignal:
        ...
```

Both `MLEngine` (LightGBM) and `LSTMEngine` return the same `MLSignal` type. The SIR
`ml_signal` entry condition and all downstream consumers require no changes.

### Multi-timeframe context (v2 enhancement)

Forex is fractal — a 1H signal without M15 and H4 context is blind to the dominant structure.
Adding higher-TF features to each row is high-value but requires aligning candle timestamps
across timeframes:

```python
# Example: join H4 and D1 features onto the 1H row by timestamp alignment
df["ema200_h4"]  = resample_ema(ohlcv_1h, span=200, target_tf="4H")
df["rsi14_h4"]   = resample_rsi(ohlcv_1h, period=14, target_tf="4H")
df["adx14_d1"]   = resample_adx(ohlcv_1h, period=14, target_tf="1D")
```

Infrastructure requirement: `features.py` must accept multi-TF OHLCV frames and produce a
merged row. The `trainer.py` CLI gains `--context-timeframes H4,1D`. Not needed for v1 baseline.

### Build order (v2)

1. Validate that LightGBM v1 is live and producing real edge
2. Add regime + liquidity heuristic labelers to `ml/trainer.py`
3. Implement `backend/ml/lstm_trainer.py` — PyTorch, same CLI interface as LightGBM trainer
4. Implement `backend/ml/lstm_inference.py` — `LSTMEngine` class
5. Add `"lstm"` to `ml_models.algorithm` column; activate via same `/api/ml/models/{id}/activate`
6. Implement decision engine layer in `live/engine.py` and `engine/runner.py`
7. Run shadow mode comparison: SSLT signals vs LightGBM signals on same candles

---

## Out of scope (v1)

- Deep learning models (LSTM, Transformer) — scoped in v2 SSLT section above; not built until LightGBM v1 is proven
- Automated retraining on schedule — manual retrain + activate for now
- Multi-pair ensemble models — one model per (pair, timeframe) only
- Multi-timeframe context features — scoped in v2 SSLT section above
- Walk-forward optimisation — validate manually; automate in v2
- Real-time feature drift monitoring — log predictions, analyse offline
