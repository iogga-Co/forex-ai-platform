-- Add AI model column to optimization_runs
-- Tracks which model was used for each optimization run.
ALTER TABLE optimization_runs
    ADD COLUMN IF NOT EXISTS model VARCHAR(60) NOT NULL DEFAULT 'claude-opus-4-6';
