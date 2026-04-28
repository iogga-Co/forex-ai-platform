-- Phase 5.4: RAG Evaluation
-- Logs which chunks were retrieved per Co-Pilot chat for quality analysis.

CREATE TABLE rag_retrievals (
    id          BIGSERIAL    PRIMARY KEY,
    session_id  UUID         NOT NULL,
    source      VARCHAR(20)  NOT NULL,   -- 'conversation' | 'strategy' | 'backtest'
    chunk_id    TEXT         NOT NULL,   -- ID of the retrieved item
    rrf_score   REAL         NOT NULL,
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_rag_retrievals_session ON rag_retrievals(session_id);
CREATE INDEX idx_rag_retrievals_created ON rag_retrievals(created_at DESC);
