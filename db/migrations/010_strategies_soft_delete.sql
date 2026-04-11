-- =============================================================================
-- Soft-delete for strategies.
--
-- Deleted strategies are hidden from the UI (list / dropdown) but kept in the
-- DB so their embeddings remain available for RAG retrieval.  The Co-Pilot
-- labels them [DELETED] in context so Claude learns to avoid repeating them.
-- =============================================================================

ALTER TABLE strategies
    ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ DEFAULT NULL;
