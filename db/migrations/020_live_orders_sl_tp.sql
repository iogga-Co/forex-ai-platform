-- Add SL/TP prices, R-multiple, and shadow_mode flag to live_orders.
-- sl_price / tp_price: the levels submitted to OANDA with the order.
-- r_multiple: realised R at close (pnl / risk_amount), computed by executor.
-- shadow_mode: TRUE when the order was NOT sent to OANDA (signal logged only).

ALTER TABLE live_orders ADD COLUMN sl_price    NUMERIC(18, 8);
ALTER TABLE live_orders ADD COLUMN tp_price    NUMERIC(18, 8);
ALTER TABLE live_orders ADD COLUMN r_multiple  NUMERIC(8, 4);
ALTER TABLE live_orders ADD COLUMN shadow_mode BOOLEAN NOT NULL DEFAULT FALSE;
