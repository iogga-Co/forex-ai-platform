-- =============================================================================
-- strategies
-- Every strategy version is stored permanently — nothing is ever deleted.
-- description and the embedding column are used for RAG retrieval.
-- Populated by the AI Co-Pilot (Phase 2).
-- =============================================================================

CREATE TABLE IF NOT EXISTS strategies (
    id                    UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
    version               INTEGER         NOT NULL,
    ir_json               JSONB           NOT NULL,               -- Strategy IR document
    description           TEXT            NOT NULL,               -- Human-readable summary of rules
    pair                  VARCHAR(10)     NOT NULL,               -- Primary pair this strategy targets
    timeframe             VARCHAR(5)      NOT NULL,
    created_from_turn_id  UUID,                                   -- conversation_turns.id that produced this version
    embedding             vector(1024),                           -- Voyage AI embedding of description (RAG)
    created_at            TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);

-- Look up all versions of strategies for a given pair/timeframe
CREATE INDEX IF NOT EXISTS idx_strategies_pair_timeframe
    ON strategies (pair, timeframe, created_at DESC);

-- IVFFlat index for cosine similarity search on embeddings.
-- lists=100 is a reasonable default; tune upward once the table has >100k rows.
CREATE INDEX IF NOT EXISTS idx_strategies_embedding
    ON strategies USING ivfflat (embedding vector_cosine_ops)
    WITH (lists = 100);
