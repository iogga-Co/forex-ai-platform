-- Indicator Lab: saved indicator configurations.
-- Each row stores a named composition of indicator series a user built in the Lab.
-- These are NOT strategies — they have no entry/exit logic or PnL.
-- signal_conditions stores optional entry-condition-style rules for chart markers.

CREATE TABLE saved_indicators (
    id                 UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id            TEXT         NOT NULL,
    name               VARCHAR(200) NOT NULL,
    status             VARCHAR(20)  NOT NULL DEFAULT 'draft'
                                    CHECK (status IN ('draft', 'complete')),
    indicator_config   JSONB        NOT NULL DEFAULT '{"indicators":[]}',
    signal_conditions  JSONB        NOT NULL DEFAULT '[]',
    created_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_saved_indicators_user ON saved_indicators(user_id, updated_at DESC);
