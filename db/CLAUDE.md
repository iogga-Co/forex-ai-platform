# Database

- **TimescaleDB** (PostgreSQL extension) for OHLCV time-series
- **pgvector** for strategy embedding/retrieval
- Migrations in `db/migrations/` — **only auto-applied on a fresh volume**. For existing deployments, run manually:

```bash
docker exec forex-ai-platform-timescaledb-1 psql -U forex_user -d forex_db -f /path/to/migration.sql
```

CI deploy loop runs all migrations with `|| true` so already-applied ones are silently ignored.

---

## Key tables

| Table | Purpose |
|---|---|
| `strategies` | Strategy records with `ir_json` JSONB |
| `backtest_runs` | Backtest job metadata AND completed run metrics (sharpe, max_dd, win_rate, trade_count, etc.) |
| `trades` | Individual trade records (pnl, r_multiple, mae, mfe, entry_time, exit_time, direction) |
| `optimization_runs` | Optimization session metadata; `model VARCHAR(60)` column (migration 016) |
| `optimization_iterations` | Per-iteration results with `strategy_ir` JSONB |
| `ohlcv_candles` | TimescaleDB hypertable — 6 pairs × 2 stored timeframes (`1m`, `1H`) |
| `ai_usage_log` | Token usage per AI call — model, feature, input/output counts (migration 015) |
| `news_events` | ForexFactory calendar events — `UNIQUE(event_time, currency, title)` |
| `live_orders` | Live trade execution records — status, direction, size, entry/exit prices, SL/TP, R-multiple, shadow_mode (migration 007 + 020) |
| `saved_indicators` | Indicator Lab: named indicator configs (indicator_config JSONB, signal_conditions JSONB) — migration 021 |
| `operator_mfa` | TOTP secrets for kill-switch MFA (migration 022) |
| `g_optimize_runs` | G-Optimize run metadata with `entry_config`/`exit_config` JSONB |
| `rag_retrievals` | Logs each chunk retrieved per Co-Pilot chat — session_id, source, chunk_id, rrf_score (migration 024) |

**Note:** There is NO separate `backtest_results` table. `backtest_runs` is the single table for both job metadata and result metrics. All diagnosis/analytics queries use `FROM backtest_runs`.

---

## OHLCV coverage

All 6 pairs fully loaded: `EURUSD`, `GBPUSD`, `USDJPY`, `EURGBP`, `GBPJPY`, `USDCHF`
Coverage: April 2021 – April 2026 · Stored timeframes: `1m`, `1H`

---

## On-the-fly timeframe resampling

`data/db.py` `fetch_candles()` and `routers/candles.py` support 7 timeframes. Only `1m` and `1H` are stored; the rest are resampled at query time using pandas:

| Timeframe | Pandas rule | Source |
|---|---|---|
| `1m` | — | stored |
| `5m` | `5min` | resampled from 1m |
| `15m` | `15min` | resampled from 1m |
| `30m` | `30min` | resampled from 1m |
| `1H` | — | stored |
| `4H` | `4h` | resampled from 1m |
| `1D` | `1D` | resampled from 1m |

OHLCV aggregation: `open=first, high=max, low=min, close=last, volume=sum`. The analytics indicator overlay endpoints scale the 300-bar warmup window by `minutes_per_bar` so indicators are always fully primed regardless of timeframe.
