-- =============================================================================
-- Fix FK constraints that block backtest_run deletion.
-- optimization_runs.best_backtest_id and optimization_iterations.backtest_run_id
-- both referenced backtest_runs(id) with no ON DELETE action (defaults to
-- RESTRICT), causing a FK violation when a backtest is deleted.
-- Change both to ON DELETE SET NULL so deleting a backtest clears the
-- reference instead of blocking the delete.
-- =============================================================================

ALTER TABLE optimization_runs
    DROP CONSTRAINT IF EXISTS optimization_runs_best_backtest_id_fkey,
    ADD CONSTRAINT optimization_runs_best_backtest_id_fkey
        FOREIGN KEY (best_backtest_id) REFERENCES backtest_runs(id) ON DELETE SET NULL;

ALTER TABLE optimization_iterations
    DROP CONSTRAINT IF EXISTS optimization_iterations_backtest_run_id_fkey,
    ADD CONSTRAINT optimization_iterations_backtest_run_id_fkey
        FOREIGN KEY (backtest_run_id) REFERENCES backtest_runs(id) ON DELETE SET NULL;
