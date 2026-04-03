-- =============================================================================
-- live_orders
-- Live execution record — separate from backtest trades table.
-- Every order submitted to OANDA is recorded here immediately,
-- before confirmation, so no execution event is ever lost.
-- Populated by the Live Trading Engine (Phase 4).
-- =============================================================================

CREATE TABLE IF NOT EXISTS live_orders (
    id              UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
    strategy_id     UUID          NOT NULL REFERENCES strategies(id),
    oanda_order_id  VARCHAR(64),                -- set after OANDA confirms the order
    status          VARCHAR(20)   NOT NULL
                                  CHECK (status IN ('pending', 'filled', 'partial', 'cancelled', 'rejected'))
                                  DEFAULT 'pending',
    direction       VARCHAR(5)    NOT NULL CHECK (direction IN ('long', 'short')),
    size            NUMERIC(18, 2) NOT NULL,    -- units (e.g. 10000 = 1 mini lot)
    entry_price     NUMERIC(18, 8),             -- null until filled
    exit_price      NUMERIC(18, 8),             -- null until closed
    pnl             NUMERIC(18, 4),             -- null until closed
    reject_reason   TEXT,                       -- populated on rejection for post-incident review
    opened_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    closed_at       TIMESTAMPTZ                 -- null while position is open
);

-- Current open positions: strategy + status filter
CREATE INDEX IF NOT EXISTS idx_live_orders_strategy_status
    ON live_orders (strategy_id, status, opened_at DESC);

-- Time-ordered log of all executions
CREATE INDEX IF NOT EXISTS idx_live_orders_opened_at
    ON live_orders (opened_at DESC);
