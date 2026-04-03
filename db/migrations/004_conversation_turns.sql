-- =============================================================================
-- conversation_turns
-- Full dialog history — every user and AI message, permanently indexed.
-- Both content and embedding are used for RAG retrieval so that
-- prior conversations surface automatically when discussing similar topics.
-- Populated by the AI Co-Pilot (Phase 2).
-- =============================================================================

CREATE TABLE IF NOT EXISTS conversation_turns (
    id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id   UUID        NOT NULL,                   -- groups turns belonging to one browser session
    role         VARCHAR(10) NOT NULL                    -- "user" or "assistant"
                             CHECK (role IN ('user', 'assistant')),
    content      TEXT        NOT NULL,                   -- full message text
    strategy_id  UUID        REFERENCES strategies(id),  -- strategy being discussed at time of turn (nullable)
    embedding    vector(1024),                           -- Voyage AI embedding of content (RAG)
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Retrieve all turns for a session in order
CREATE INDEX IF NOT EXISTS idx_conversation_turns_session
    ON conversation_turns (session_id, created_at ASC);

-- Retrieve all turns referencing a specific strategy version
CREATE INDEX IF NOT EXISTS idx_conversation_turns_strategy
    ON conversation_turns (strategy_id, created_at DESC);

-- Full-text search index (BM25 via tsvector) for exact keyword matching
-- on ticker names, indicator names, and metric values.
ALTER TABLE conversation_turns
    ADD COLUMN IF NOT EXISTS content_tsv tsvector
    GENERATED ALWAYS AS (to_tsvector('english', content)) STORED;

CREATE INDEX IF NOT EXISTS idx_conversation_turns_fts
    ON conversation_turns USING GIN (content_tsv);

-- IVFFlat index for vector similarity search
CREATE INDEX IF NOT EXISTS idx_conversation_turns_embedding
    ON conversation_turns USING ivfflat (embedding vector_cosine_ops)
    WITH (lists = 100);
