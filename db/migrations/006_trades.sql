-- =============================================================================
-- trades
-- Per-trade granularity for every simulated trade in a backtest run.
-- signal_context stores indicator values at entry — used for trade-level
-- RAG retrieval (e.g. "find trades where RSI was above 70 at entry").
-- Populated by the backtesting engine (Phase 1).
-- =============================================================================

CREATE TABLE IF NOT EXISTS trades (
    id               UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
    backtest_run_id  UUID          NOT NULL REFERENCES backtest_runs(id) ON DELETE CASCADE,

    -- Execution
    entry_time       TIMESTAMPTZ   NOT NULL,
    exit_time        TIMESTAMPTZ   NOT NULL,
    direction        VARCHAR(5)    NOT NULL CHECK (direction IN ('long', 'short')),
    entry_price      NUMERIC(18, 8) NOT NULL,
    exit_price       NUMERIC(18, 8) NOT NULL,

    -- Outcome
    pnl              NUMERIC(18, 4) NOT NULL,    -- in account currency units
    r_multiple       NUMERIC(10, 4) NOT NULL,    -- pnl expressed as multiples of initial risk
    mae              NUMERIC(18, 8) NOT NULL,    -- max adverse excursion (price units)
    mfe              NUMERIC(18, 8) NOT NULL,    -- max favorable excursion (price units)

    -- Context at entry — indicator values, session, day-of-week, etc.
    -- Stored as JSONB so it flexes to any set of indicators without schema changes.
    signal_context   JSONB         NOT NULL DEFAULT '{}'::jsonb,
    embedding        vector(1024)             -- Voyage AI embedding of signal_context text (RAG)
);

-- Primary access pattern: all trades for a given backtest run
CREATE INDEX IF NOT EXISTS idx_trades_backtest_run
    ON trades (backtest_run_id, entry_time ASC);

-- Analytics queries: filter by direction across a run
CREATE INDEX IF NOT EXISTS idx_trades_direction
    ON trades (backtest_run_id, direction);

-- IVFFlat index for vector similarity on signal_context embeddings
CREATE INDEX IF NOT EXISTS idx_trades_embedding
    ON trades USING ivfflat (embedding vector_cosine_ops)
    WITH (lists = 100);
