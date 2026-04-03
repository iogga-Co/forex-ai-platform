-- =============================================================================
-- ohlcv_candles
-- Primary price data store for all backtesting queries.
-- Converted to a TimescaleDB hypertable partitioned by time.
-- Populated by the data pipeline (Phase 1): Dukascopy + yfinance ingest.
-- =============================================================================

CREATE TABLE IF NOT EXISTS ohlcv_candles (
    pair        VARCHAR(10)     NOT NULL,               -- e.g. "EURUSD", "GBPUSD"
    timeframe   VARCHAR(5)      NOT NULL,               -- e.g. "1m", "5m", "1H", "1D"
    timestamp   TIMESTAMPTZ     NOT NULL,               -- bar open time, always UTC
    open        NUMERIC(18, 8)  NOT NULL,
    high        NUMERIC(18, 8)  NOT NULL,
    low         NUMERIC(18, 8)  NOT NULL,
    close       NUMERIC(18, 8)  NOT NULL,
    volume      NUMERIC(20, 2)  NOT NULL DEFAULT 0,

    PRIMARY KEY (pair, timeframe, timestamp)
);

-- Convert to TimescaleDB hypertable partitioned by timestamp.
-- chunk_time_interval of 1 week balances query performance and chunk count
-- for the expected data density (1m candles = ~7,200 rows/week per pair).
SELECT create_hypertable(
    'ohlcv_candles',
    'timestamp',
    chunk_time_interval => INTERVAL '1 week',
    if_not_exists       => TRUE
);

-- Composite index covering the most common query pattern:
-- "give me all 1H EURUSD candles between date A and date B"
-- The PRIMARY KEY already provides (pair, timeframe, timestamp) ordering,
-- but an explicit index makes range scans faster on TimescaleDB chunks.
CREATE INDEX IF NOT EXISTS idx_ohlcv_pair_timeframe_time
    ON ohlcv_candles (pair, timeframe, timestamp DESC);
