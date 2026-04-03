-- =============================================================================
-- Extensions
-- Must run before any table that uses vector() or hypertable features.
-- =============================================================================

-- TimescaleDB — time-series optimized storage and hypertable partitioning
CREATE EXTENSION IF NOT EXISTS timescaledb CASCADE;

-- pgvector — vector similarity search for RAG retrieval
-- Adds the vector type and ivfflat / hnsw index methods
CREATE EXTENSION IF NOT EXISTS vector;

-- pgcrypto — gen_random_uuid() for UUID primary keys
CREATE EXTENSION IF NOT EXISTS pgcrypto;
