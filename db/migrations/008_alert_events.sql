-- =============================================================================
-- alert_events
-- System-wide event log for all monitoring tiers:
--   CRITICAL — immediate operator action required
--   WARNING  — investigate within the hour
--   INFO     — review in daily log check, no urgency
--
-- Every component writes here. Grafana/Loki queries this table.
-- Populated by all subsystems across all phases.
-- =============================================================================

CREATE TABLE IF NOT EXISTS alert_events (
    id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    level       VARCHAR(10) NOT NULL CHECK (level IN ('critical', 'warning', 'info')),
    type        VARCHAR(64) NOT NULL,       -- e.g. "order_unconfirmed", "daily_loss_limit", "backtest_complete"
    message     TEXT        NOT NULL,
    context     JSONB       NOT NULL DEFAULT '{}'::jsonb,  -- structured metadata for the event
    resolved    BOOLEAN     NOT NULL DEFAULT FALSE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    resolved_at TIMESTAMPTZ                -- null until operator marks as resolved
);

-- Primary query pattern: unresolved critical alerts (oncall dashboard)
CREATE INDEX IF NOT EXISTS idx_alert_events_level_resolved
    ON alert_events (level, resolved, created_at DESC);

-- Time-ordered full log
CREATE INDEX IF NOT EXISTS idx_alert_events_created_at
    ON alert_events (created_at DESC);
