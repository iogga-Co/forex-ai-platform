-- Migration 012: optimization_iterations table
-- One row per backtest loop iteration within an optimization run.

CREATE TABLE optimization_iterations (
    id               UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id           UUID    NOT NULL REFERENCES optimization_runs(id) ON DELETE CASCADE,
    iteration_number INTEGER NOT NULL,
    strategy_ir      JSONB   NOT NULL,

    -- Backtest result pointer
    backtest_run_id  UUID    REFERENCES backtest_runs(id),

    -- Denormalised metrics for fast table render (avoids joining backtest_runs)
    sharpe           NUMERIC(8,4),
    win_rate         NUMERIC(6,4),
    max_dd           NUMERIC(8,4),
    total_pnl        NUMERIC(14,4),
    trade_count      INTEGER,

    -- AI output for this iteration
    ai_analysis      TEXT,   -- Claude's plain-English interpretation of results
    ai_changes       TEXT,   -- Summary of tool calls applied

    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE (run_id, iteration_number)
);

CREATE INDEX idx_opt_iter_run ON optimization_iterations(run_id, iteration_number);
