-- =============================================================================
-- backtest_runs — add celery_task_id for idempotent Celery task retries
--
-- If a Celery worker crashes mid-task and retries, the INSERT INTO
-- backtest_runs would create a duplicate row.  Storing the Celery task ID
-- and using ON CONFLICT DO NOTHING prevents duplicate rows on retry.
-- =============================================================================

ALTER TABLE backtest_runs
    ADD COLUMN IF NOT EXISTS celery_task_id VARCHAR(36);

-- Partial unique index: only enforces uniqueness for non-NULL values
-- (rows inserted outside of Celery — e.g., fixtures — can have NULL).
CREATE UNIQUE INDEX IF NOT EXISTS idx_backtest_runs_task_id
    ON backtest_runs (celery_task_id)
    WHERE celery_task_id IS NOT NULL;
