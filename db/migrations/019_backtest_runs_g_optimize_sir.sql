-- Allow NULL strategy_id for g_optimize source rows (no user-created strategy exists yet).
-- Add sir_json to store the sampled SIR directly on each g_optimize backtest run.
-- Must be applied after 018_backtest_runs_source.sql.

ALTER TABLE backtest_runs ALTER COLUMN strategy_id DROP NOT NULL;
ALTER TABLE backtest_runs ADD COLUMN sir_json JSONB;
