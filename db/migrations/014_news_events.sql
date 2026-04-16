-- =============================================================================
-- Create news_events table for economic calendar storage.
-- Events are fetched from ForexFactory (Phase 1) or a paid feed (Phase 2)
-- and cached here for historical correlation queries.
-- =============================================================================

CREATE TABLE IF NOT EXISTS news_events (
    id          SERIAL PRIMARY KEY,
    event_time  TIMESTAMPTZ NOT NULL,
    currency    VARCHAR(3)  NOT NULL,
    title       TEXT        NOT NULL,
    impact      VARCHAR(6)  NOT NULL,   -- 'high' | 'medium' | 'low'
    forecast    TEXT,
    actual      TEXT,
    previous    TEXT,
    source      VARCHAR(50) NOT NULL DEFAULT 'forexfactory',
    fetched_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (event_time, currency, title)
);

CREATE INDEX IF NOT EXISTS news_events_time_currency_idx
    ON news_events (event_time, currency);
