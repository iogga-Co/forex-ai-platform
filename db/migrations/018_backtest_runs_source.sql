-- Extend backtest_runs with G-Optimize provenance columns.
-- Must be applied after 017_g_optimize_runs.sql.

ALTER TABLE backtest_runs
    ADD COLUMN source            VARCHAR(20) NOT NULL DEFAULT 'manual',
                                 -- 'manual' | 'optimization' | 'g_optimize'
    ADD COLUMN g_optimize_run_id UUID REFERENCES g_optimize_runs(id) ON DELETE SET NULL,
    ADD COLUMN passed_threshold  BOOLEAN;
                                 -- NULL for manual/optimization; TRUE/FALSE for g_optimize rows

CREATE INDEX idx_backtest_runs_source     ON backtest_runs(source);
CREATE INDEX idx_backtest_runs_g_optimize ON backtest_runs(g_optimize_run_id)
    WHERE g_optimize_run_id IS NOT NULL;
