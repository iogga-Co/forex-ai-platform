CREATE TABLE IF NOT EXISTS ai_usage_log (
    id            SERIAL PRIMARY KEY,
    model         VARCHAR(60)  NOT NULL,
    feature       VARCHAR(40)  NOT NULL DEFAULT 'unknown',
    input_tokens  INTEGER      NOT NULL DEFAULT 0,
    output_tokens INTEGER      NOT NULL DEFAULT 0,
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ai_usage_log_model_time_idx ON ai_usage_log (model, created_at);
