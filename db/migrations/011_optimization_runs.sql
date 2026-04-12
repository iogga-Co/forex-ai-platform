-- Migration 011: optimization_runs table
-- Tracks each AI-driven optimization session.

CREATE TABLE optimization_runs (
    id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID        REFERENCES users(id),
    pair                VARCHAR(10) NOT NULL,
    timeframe           VARCHAR(10) NOT NULL,
    period_start        DATE        NOT NULL,
    period_end          DATE        NOT NULL,
    initial_strategy_id UUID        REFERENCES strategies(id),
    system_prompt       TEXT        NOT NULL DEFAULT '',
    user_prompt         TEXT        NOT NULL DEFAULT '',

    -- Stopping conditions
    max_iterations      INTEGER     NOT NULL DEFAULT 20,
    time_limit_minutes  INTEGER     NOT NULL DEFAULT 600,
    target_win_rate     NUMERIC(6,4),   -- e.g. 0.6000 = 60 %
    target_sharpe       NUMERIC(8,4),

    -- Runtime state
    -- pending | running | completed | stopped | failed
    status              VARCHAR(20) NOT NULL DEFAULT 'pending',
    current_iteration   INTEGER     NOT NULL DEFAULT 0,
    celery_task_id      TEXT,
    stop_reason         TEXT,           -- time_limit | max_iterations | target_win_rate | target_sharpe | user_stopped

    -- Best result pointers (updated after each iteration)
    best_iteration      INTEGER,
    best_backtest_id    UUID        REFERENCES backtest_runs(id),
    best_strategy_id    UUID        REFERENCES strategies(id),
    best_sharpe         NUMERIC(8,4),
    best_win_rate       NUMERIC(6,4),

    -- Timestamps
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    started_at          TIMESTAMPTZ,
    completed_at        TIMESTAMPTZ
);

CREATE INDEX idx_opt_runs_user ON optimization_runs(user_id, created_at DESC);
CREATE INDEX idx_opt_runs_status ON optimization_runs(status) WHERE status IN ('pending', 'running');
