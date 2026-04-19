-- G-Optimize runs table.
-- Stores configuration and progress for each global strategy discovery run.
-- user_id matches the pattern used by optimization_runs (TEXT, JWT sub claim, no FK).

CREATE TABLE g_optimize_runs (
    id                   UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id              TEXT,
    status               VARCHAR(20)  NOT NULL DEFAULT 'pending',
                         -- 'pending' | 'running' | 'done' | 'stopped' | 'failed'
    pairs                TEXT[]       NOT NULL,
    timeframe            VARCHAR(5)   NOT NULL DEFAULT '1H',
    period_start         DATE         NOT NULL,
    period_end           DATE         NOT NULL,
    n_configs            INTEGER      NOT NULL,
    store_trades         VARCHAR(10)  NOT NULL DEFAULT 'passing',
                         -- 'passing' | 'all' | 'none'
    entry_config         JSONB        NOT NULL,
    exit_config          JSONB        NOT NULL,
    threshold_sharpe     NUMERIC(5,2) NOT NULL,
    threshold_win_rate   NUMERIC(5,2) NOT NULL,
    threshold_max_dd     NUMERIC(5,2) NOT NULL,
    threshold_min_trades INTEGER      NOT NULL,
    auto_rag             BOOLEAN      NOT NULL DEFAULT TRUE,
    configs_total        INTEGER      NOT NULL DEFAULT 0,
    configs_done         INTEGER      NOT NULL DEFAULT 0,
    configs_passed       INTEGER      NOT NULL DEFAULT 0,
    configs_failed       INTEGER      NOT NULL DEFAULT 0,
    error_message        TEXT,
    started_at           TIMESTAMPTZ,
    completed_at         TIMESTAMPTZ,
    created_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_g_optimize_runs_user ON g_optimize_runs(user_id, created_at DESC);
CREATE INDEX idx_g_optimize_runs_status ON g_optimize_runs(status)
    WHERE status IN ('pending', 'running');
