"""
Order executor — Phase 4 PR3.

Receives TradeSignal events from the signal engine (via Redis live:signals),
submits market orders to OANDA, and tracks the full order lifecycle in the
live_orders table.

Only active when LIVE_TRADING_ENABLED=true.  In shadow mode (false) the
executor is not started — signals are still logged but never reach here.

Order lifecycle:
  pending  → order submitted to OANDA, awaiting fill confirmation
  filled   → fill confirmed, position is open
  closed   → position closed (SL/TP hit or kill-switch)
  cancelled → kill-switch closed the position manually
  rejected  → OANDA rejected the order
"""

from __future__ import annotations

import asyncio
import json
import logging
from uuid import UUID

import redis.asyncio as aioredis

from core.config import settings
from live.oanda import OandaClient

logger = logging.getLogger(__name__)

SIGNAL_CHANNEL  = "live:signals"
POLL_INTERVAL_S = 5.0    # seconds between open-position polls


# ---------------------------------------------------------------------------
# ATR-based position sizing (mirrors engine/sizing.py logic)
# ---------------------------------------------------------------------------

def _compute_units(
    atr_value: float,
    multiplier: float,
    risk_per_trade_pct: float,
    account_balance: float,
    pair: str,
) -> int:
    """
    Calculate position size in units from ATR stop distance.

    risk_amount = account_balance × risk_per_trade_pct / 100
    stop_distance = atr_value × multiplier
    pip_value ≈ 1 pip in account currency (simplified: 0.0001 for non-JPY, 0.01 for JPY)
    units = risk_amount / stop_distance
    """
    if atr_value <= 0 or multiplier <= 0:
        return 1000  # minimum safe fallback

    risk_amount   = account_balance * risk_per_trade_pct / 100.0
    stop_distance = atr_value * multiplier
    if stop_distance <= 0:
        return 1000

    units = int(risk_amount / stop_distance)
    # Clamp to sensible bounds: 1 unit minimum, 100k maximum
    return max(1, min(units, 100_000))


# ---------------------------------------------------------------------------
# Executor
# ---------------------------------------------------------------------------

class LiveExecutor:
    """
    Subscribes to Redis live:signals and places orders via OANDA.
    Polls open positions every POLL_INTERVAL_S seconds.
    """

    def __init__(self, pool) -> None:
        self._pool  = pool
        self._oanda = OandaClient(
            api_key=settings.oanda_api_key,
            account_id=settings.oanda_account_id,
            environment=settings.oanda_environment,
        )

    # ------------------------------------------------------------------
    # Main loop
    # ------------------------------------------------------------------

    async def run(self, stop_event: asyncio.Event) -> None:
        logger.info("LiveExecutor started (env=%s)", settings.oanda_environment)
        r: aioredis.Redis | None = None
        try:
            r = aioredis.from_url(settings.redis_url, decode_responses=True)
            pubsub = r.pubsub()
            await pubsub.subscribe(SIGNAL_CHANNEL)

            poll_task = asyncio.create_task(
                self._poll_positions(stop_event), name="executor-poll"
            )

            while not stop_event.is_set():
                msg = await pubsub.get_message(
                    ignore_subscribe_messages=True, timeout=5.0
                )
                if msg is None:
                    continue
                try:
                    signal = json.loads(msg["data"])
                except Exception:
                    continue

                # Only act on non-shadow signals
                if signal.get("shadow", True):
                    continue

                asyncio.create_task(self._handle_signal(signal))

            poll_task.cancel()
            await asyncio.gather(poll_task, return_exceptions=True)

        except asyncio.CancelledError:
            pass
        except Exception as exc:
            logger.error("LiveExecutor fatal: %s", exc, exc_info=True)
        finally:
            if r is not None:
                try:
                    await r.aclose()
                except Exception:
                    pass
        logger.info("LiveExecutor stopped")

    # ------------------------------------------------------------------
    # Signal handling
    # ------------------------------------------------------------------

    async def _handle_signal(self, signal: dict) -> None:
        pair        = signal["pair"]
        strategy_id = signal.get("strategy_id")
        direction   = signal.get("direction", "long")
        if not strategy_id:
            return

        try:
            # Fetch strategy IR for sizing parameters
            ir = await self._fetch_strategy_ir(strategy_id)
            if ir is None:
                logger.warning("Executor: strategy %s not found", strategy_id)
                return

            # Get account balance for position sizing
            account = await self._oanda.get_account_summary()
            balance = float(account.get("balance", 10_000))

            # Calculate units from ATR sizing
            sl_cfg    = (ir.get("exit_conditions") or {}).get("stop_loss", {})
            sizing    = ir.get("position_sizing") or {}
            sl_mult   = float(sl_cfg.get("multiplier", 1.5))
            risk_pct  = float(sizing.get("risk_per_trade_pct", 1.0))
            atr_value = 0.0005  # fallback if ATR not available live

            units = _compute_units(atr_value, sl_mult, risk_pct, balance, pair)
            if direction == "short":
                units = -units

            # SL/TP distances kept for PR4 where live ATR will set exact prices
            tp_cfg  = (ir.get("exit_conditions") or {}).get("take_profit", {})
            _ = float(tp_cfg.get("multiplier", 3.0))  # tp_mult — used in PR4

            # Insert live_order row (status=pending)
            order_id = await self._insert_order(
                strategy_id=strategy_id,
                pair=pair,
                direction=direction,
                units=abs(units),
            )

            # Place order with OANDA
            try:
                result = await self._oanda.place_market_order(
                    instrument=pair,
                    units=units,
                )
                oanda_order_id = (
                    result.get("orderFillTransaction", {}).get("id")
                    or result.get("orderCreateTransaction", {}).get("id")
                )
                entry_price = float(
                    result.get("orderFillTransaction", {}).get("price", 0) or 0
                )
                await self._update_order_filled(
                    order_id=order_id,
                    oanda_order_id=oanda_order_id,
                    entry_price=entry_price or None,
                )
                logger.info(
                    "Order filled: %s %s %d units @ %.5f",
                    pair, direction, abs(units), entry_price,
                )
            except Exception as exc:
                logger.error("OANDA order failed for %s: %s", pair, exc)
                await self._update_order_rejected(order_id, str(exc))

        except Exception as exc:
            logger.error("Executor signal handler failed for %s: %s", pair, exc, exc_info=True)

    # ------------------------------------------------------------------
    # Open-position polling
    # ------------------------------------------------------------------

    async def _poll_positions(self, stop_event: asyncio.Event) -> None:
        """Poll OANDA every POLL_INTERVAL_S for filled/closed positions."""
        while not stop_event.is_set():
            await asyncio.sleep(POLL_INTERVAL_S)
            try:
                positions = await self._oanda.get_open_positions()
                open_pairs = {
                    p["instrument"].replace("_", "")
                    for p in positions
                }
                # Close out any live_orders rows whose position is gone
                await self._reconcile_closed(open_pairs)
            except asyncio.CancelledError:
                break
            except Exception as exc:
                logger.debug("Position poll error: %s", exc)

    async def _reconcile_closed(self, open_pairs: set[str]) -> None:
        """Mark live_orders as closed when OANDA no longer shows the position."""
        async with self._pool.acquire() as conn:
            rows = await conn.fetch(
                """
                SELECT id, pair FROM live_orders
                WHERE status = 'filled'
                """
            )
            for row in rows:
                if row["pair"] not in open_pairs:
                    await conn.execute(
                        """
                        UPDATE live_orders
                        SET status = 'closed', closed_at = NOW()
                        WHERE id = $1
                        """,
                        row["id"],
                    )

    # ------------------------------------------------------------------
    # Kill switch
    # ------------------------------------------------------------------

    async def kill_switch(self) -> int:
        """
        Close all open positions via OANDA and mark live_orders cancelled.
        Returns the number of positions closed.
        """
        closed = 0
        try:
            positions = await self._oanda.get_open_positions()
            for pos in positions:
                pair = pos["instrument"].replace("_", "")
                try:
                    await self._oanda.close_position(pair)
                    closed += 1
                    logger.info("Kill switch: closed %s", pair)
                except Exception as exc:
                    logger.error("Kill switch close failed for %s: %s", pair, exc)
        except Exception as exc:
            logger.error("Kill switch: failed to fetch positions: %s", exc)

        # Mark all filled orders as cancelled
        async with self._pool.acquire() as conn:
            await conn.execute(
                """
                UPDATE live_orders
                SET status = 'cancelled', closed_at = NOW()
                WHERE status IN ('pending', 'filled')
                """
            )
        return closed

    # ------------------------------------------------------------------
    # DB helpers
    # ------------------------------------------------------------------

    async def _fetch_strategy_ir(self, strategy_id: str) -> dict | None:
        async with self._pool.acquire() as conn:
            row = await conn.fetchrow(
                "SELECT ir_json FROM strategies WHERE id = $1", strategy_id
            )
        return dict(row["ir_json"]) if row else None

    async def _insert_order(
        self,
        strategy_id: str,
        pair: str,
        direction: str,
        units: int,
    ) -> UUID:
        async with self._pool.acquire() as conn:
            row = await conn.fetchrow(
                """
                INSERT INTO live_orders (strategy_id, status, direction, size, shadow_mode)
                VALUES ($1, 'pending', $2, $3, false)
                RETURNING id
                """,
                strategy_id, direction, units,
            )
        return row["id"]

    async def _update_order_filled(
        self,
        order_id: UUID,
        oanda_order_id: str | None,
        entry_price: float | None,
    ) -> None:
        async with self._pool.acquire() as conn:
            await conn.execute(
                """
                UPDATE live_orders
                SET status = 'filled',
                    oanda_order_id = $2,
                    entry_price = $3
                WHERE id = $1
                """,
                order_id, oanda_order_id, entry_price,
            )

    async def _update_order_rejected(self, order_id: UUID, reason: str) -> None:
        async with self._pool.acquire() as conn:
            await conn.execute(
                """
                UPDATE live_orders
                SET status = 'rejected', reject_reason = $2
                WHERE id = $1
                """,
                order_id, reason[:2000],
            )


# ---------------------------------------------------------------------------
# Module-level singleton (set by main.py lifespan)
# ---------------------------------------------------------------------------
_executor: LiveExecutor | None = None


def get_executor() -> LiveExecutor | None:
    return _executor


def set_executor(ex: LiveExecutor | None) -> None:
    global _executor
    _executor = ex
