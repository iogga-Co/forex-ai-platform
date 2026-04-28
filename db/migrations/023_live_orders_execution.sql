-- Phase 5.3: Advanced Execution columns on live_orders.
-- Also adds the missing `pair` column that _reconcile_closed references.
--
-- execution_mode: how the order was placed ('market' | 'limit' | 'twap')
-- limit_price:    the limit price submitted to OANDA (NULL for market/twap)
-- spread_pips:    spread at signal time in pips, for post-trade audit
-- pair:           the currency pair (e.g. 'EURUSD') — required by reconciliation

ALTER TABLE live_orders ADD COLUMN IF NOT EXISTS pair           VARCHAR(10);
ALTER TABLE live_orders ADD COLUMN IF NOT EXISTS execution_mode VARCHAR(20) NOT NULL DEFAULT 'market';
ALTER TABLE live_orders ADD COLUMN IF NOT EXISTS limit_price    NUMERIC(18, 8);
ALTER TABLE live_orders ADD COLUMN IF NOT EXISTS spread_pips    NUMERIC(8, 4);
