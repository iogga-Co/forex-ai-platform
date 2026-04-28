"""
Order executor — Phase 4 PR3 + Phase 5.3 Advanced Execution.

Receives TradeSignal events from the signal engine (via Redis live:signals),
checks spread gating, then routes to the appropriate execution mode:
  - market  : single market order (default)
  - limit   : limit order with ATR-based offset; cancelled if unfilled after expiry
  - twap    : order split into N equal market-order slices over T minutes

Only active when LIVE_TRADING_ENABLED=true.  In shadow mode (false) the
executor is not started — signals are still logged but never reach here.

Order lifecycle:
  pending  → order submitted to OANDA, awaiting fill confirmation
  filled   → fill confirmed, position is open
  closed   → position closed (SL/TP hit or kill-switch)
  cancelled → kill-switch or limit-expiry closed the position
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
from live.twap import execute_twap

logger = logging.getLogger(__name__)

SIGNAL_CHANNEL     = "live:signals"
CMD_CHANNEL        = "live:commands"
CMD_RESULT_PREFIX  = "live:cmd_results:"
BALANCE_KEY        = "live:account_balance"
BALANCE_TTL        = 30   # seconds
POLL_INTERVAL_S    = 5.0  # seconds between open-position polls


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
        await self._reconcile_on_startup()
        r: aioredis.Redis | None = None
        try:
            r = aioredis.from_url(settings.redis_url, decode_responses=True)
            pubsub = r.pubsub()
            await pubsub.subscribe(SIGNAL_CHANNEL, CMD_CHANNEL)

            poll_task = asyncio.create_task(
                self._poll_positions(stop_event, r), name="executor-poll"
            )

            while not stop_event.is_set():
                msg = await pubsub.get_message(
                    ignore_subscribe_messages=True, timeout=5.0
                )
                if msg is None:
                    continue
                try:
                    data = json.loads(msg["data"])
                except Exception:
                    continue

                if msg["channel"] == CMD_CHANNEL:
                    asyncio.create_task(self._handle_command(data, r))
                    continue

                # live:signals — only act on non-shadow signals
                if data.get("shadow", True):
                    continue
                asyncio.create_task(self._handle_signal(data))

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
    # Redis command channel (kill-switch from web API)
    # ------------------------------------------------------------------

    async def _handle_command(self, cmd: dict, r: aioredis.Redis) -> None:
        request_id = cmd.get("request_id", "unknown")
        result: dict
        if cmd.get("cmd") == "kill_switch":
            try:
                closed = await self.kill_switch()
                result = {"ok": True, "closed": closed}
            except Exception as exc:
                result = {"ok": False, "error": str(exc)}
        else:
            result = {"ok": False, "error": f"Unknown command: {cmd.get('cmd')}"}

        result_key = CMD_RESULT_PREFIX + request_id
        await r.lpush(result_key, json.dumps(result))  # type: ignore[misc]
        await r.expire(result_key, 30)  # type: ignore[misc]

    # ------------------------------------------------------------------
    # Signal handling — top level
    # ------------------------------------------------------------------

    async def _handle_signal(self, signal: dict) -> None:
        pair        = signal["pair"]
        strategy_id = signal.get("strategy_id")
        direction   = signal.get("direction", "long")
        if not strategy_id:
            return

        try:
            ir = await self._fetch_strategy_ir(strategy_id)
            if ir is None:
                logger.warning("Executor: strategy %s not found", strategy_id)
                return

            # --- Phase 5.3: Spread gate ---
            exec_cfg     = ir.get("execution") or {}
            max_spread   = float(exec_cfg.get("max_spread_pips", 3.0))
            signal_spread = signal.get("spread_pips")
            if signal_spread is not None and float(signal_spread) > max_spread:
                logger.info(
                    "Executor: skipping %s — spread %.2f pips exceeds max %.2f pips",
                    pair, float(signal_spread), max_spread,
                )
                return

            # --- Position sizing ---
            account  = await self._oanda.get_account_summary()
            balance  = float(account.get("balance", 10_000))
            sl_cfg   = (ir.get("exit_conditions") or {}).get("stop_loss", {})
            sizing   = ir.get("position_sizing") or {}
            sl_mult  = float(sl_cfg.get("multiplier", 1.5))
            risk_pct = float(sizing.get("risk_per_trade_pct", 1.0))

            atr_value = signal.get("atr_value")
            if atr_value is None or float(atr_value) <= 0:
                logger.critical(
                    "Executor: aborting order for %s — ATR missing or zero (atr_value=%s)",
                    pair, atr_value,
                )
                return
            atr_value = float(atr_value)

            units = _compute_units(atr_value, sl_mult, risk_pct, balance, pair)
            if direction == "short":
                units = -units

            # --- Phase 5.3: Execution mode routing ---
            exec_mode  = str(exec_cfg.get("mode", "market"))
            spread_pips = float(signal_spread) if signal_spread is not None else None
            order_id = await self._insert_order(
                strategy_id=strategy_id,
                pair=pair,
                direction=direction,
                units=abs(units),
                execution_mode=exec_mode,
                spread_pips=spread_pips,
            )

            if exec_mode == "limit":
                await self._handle_limit(signal, exec_cfg, order_id, pair, units, atr_value)
            elif exec_mode == "twap":
                await self._handle_twap(exec_cfg, order_id, pair, units)
            else:
                await self._handle_market(order_id, pair, units)

        except Exception as exc:
            logger.error("Executor signal handler failed for %s: %s", pair, exc, exc_info=True)

    # ------------------------------------------------------------------
    # Execution: market order
    # ------------------------------------------------------------------

    async def _handle_market(self, order_id: UUID, pair: str, units: int) -> None:
        try:
            result = await self._oanda.place_market_order(instrument=pair, units=units)
            oanda_order_id = (
                result.get("orderFillTransaction", {}).get("id")
                or result.get("orderCreateTransaction", {}).get("id")
            )
            entry_price = float(
                result.get("orderFillTransaction", {}).get("price", 0) or 0
            )
            await self._update_order_filled(order_id, oanda_order_id, entry_price or None)
            logger.info(
                "Market order filled: %s %+d units @ %.5f",
                pair, units, entry_price,
            )
        except Exception as exc:
            logger.error("Market order failed for %s: %s", pair, exc)
            await self._update_order_rejected(order_id, str(exc))

    # ------------------------------------------------------------------
    # Execution: limit order
    # ------------------------------------------------------------------

    async def _handle_limit(
        self,
        signal: dict,
        exec_cfg: dict,
        order_id: UUID,
        pair: str,
        units: int,
        atr_value: float,
    ) -> None:
        """
        Place a limit entry at close_price ± (limit_offset_atr × atr_value).
        Long: limit below the bar's close (wait for price to pull back to us).
        Short: limit above the bar's close.
        """
        close_price = float(signal.get("close_price") or 0)
        if close_price <= 0:
            logger.warning("Executor: limit order skipped for %s — no close_price in signal", pair)
            await self._update_order_rejected(order_id, "missing close_price for limit entry")
            return

        offset_atr = float(exec_cfg.get("limit_offset_atr", 0.5))
        offset     = offset_atr * atr_value
        if units > 0:  # long: buy below current price
            limit_price = close_price - offset
        else:           # short: sell above current price
            limit_price = close_price + offset

        expiry_sec = int(exec_cfg.get("limit_expiry_minutes", 5)) * 60

        try:
            result = await self._oanda.place_limit_order(
                instrument=pair,
                units=units,
                price=limit_price,
                expiry_seconds=expiry_sec,
            )
            oanda_order_id = (
                result.get("orderCreateTransaction", {}).get("id")
                or result.get("orderFillTransaction", {}).get("id")
            )
            await self._update_order_limit_placed(order_id, oanda_order_id, limit_price)
            logger.info(
                "Limit order placed: %s %+d units @ %.5f (expiry %ds)",
                pair, units, limit_price, expiry_sec,
            )
            # Monitor in background: cancel after expiry if still unfilled
            if oanda_order_id:
                asyncio.create_task(
                    self._monitor_limit_expiry(oanda_order_id, order_id, expiry_sec),
                    name=f"limit-monitor-{oanda_order_id}",
                )
        except Exception as exc:
            logger.error("Limit order failed for %s: %s", pair, exc)
            await self._update_order_rejected(order_id, str(exc))

    async def _monitor_limit_expiry(
        self,
        oanda_order_id: str,
        order_id: UUID,
        expiry_sec: int,
    ) -> None:
        """Wait expiry_sec then cancel the limit if still unfilled."""
        await asyncio.sleep(expiry_sec)
        try:
            await self._oanda.cancel_order(oanda_order_id)
            await self._update_order_status(order_id, "cancelled")
            logger.info("Limit order %s expired — cancelled", oanda_order_id)
        except Exception:
            # Cancel failed — order was likely already filled or cancelled by OANDA GTD
            logger.debug(
                "Limit order %s cancel failed at expiry (probably filled or already gone)",
                oanda_order_id,
            )

    # ------------------------------------------------------------------
    # Execution: TWAP
    # ------------------------------------------------------------------

    async def _handle_twap(
        self,
        exec_cfg: dict,
        order_id: UUID,
        pair: str,
        units: int,
    ) -> None:
        slices       = int(exec_cfg.get("twap_slices", 3))
        interval_min = float(exec_cfg.get("twap_interval_minutes", 2))
        interval_sec = interval_min * 60

        try:
            results = await execute_twap(
                oanda=self._oanda,
                instrument=pair,
                total_units=units,
                slices=slices,
                interval_sec=interval_sec,
            )
            # Consider the TWAP filled if at least one slice succeeded
            filled_slices = [r for r in results if "error" not in r]
            if filled_slices:
                first_fill = filled_slices[0]
                entry_price = float(
                    first_fill.get("orderFillTransaction", {}).get("price", 0) or 0
                )
                oanda_order_id = first_fill.get("orderFillTransaction", {}).get("id")
                await self._update_order_filled(order_id, oanda_order_id, entry_price or None)
                logger.info(
                    "TWAP complete for %s: %d/%d slices filled",
                    pair, len(filled_slices), slices,
                )
            else:
                await self._update_order_rejected(order_id, "all TWAP slices failed")
        except Exception as exc:
            logger.error("TWAP execution failed for %s: %s", pair, exc)
            await self._update_order_rejected(order_id, str(exc))

    # ------------------------------------------------------------------
    # Open-position polling
    # ------------------------------------------------------------------

    async def _poll_positions(self, stop_event: asyncio.Event, r: aioredis.Redis | None = None) -> None:
        """Poll OANDA every POLL_INTERVAL_S for filled/closed positions.

        Also caches the account balance to Redis so the web API can read it
        without needing a direct reference to this executor instance.
        """
        while not stop_event.is_set():
            await asyncio.sleep(POLL_INTERVAL_S)
            try:
                positions = await self._oanda.get_open_positions()
                open_pairs = {
                    p["instrument"].replace("_", "")
                    for p in positions
                }
                await self._reconcile_closed(open_pairs)

                if r is not None:
                    try:
                        account = await self._oanda.get_account_summary()
                        balance = float(account.get("balance", 0) or 0)
                        await r.setex(BALANCE_KEY, BALANCE_TTL, str(balance))
                    except Exception:
                        pass  # non-fatal — balance cache miss handled by status endpoint
            except asyncio.CancelledError:
                break
            except Exception as exc:
                logger.debug("Position poll error: %s", exc)

    async def _reconcile_on_startup(self) -> None:
        """Sync stale filled orders against OANDA on startup."""
        try:
            positions = await self._oanda.get_open_positions()
            open_pairs = {p["instrument"].replace("_", "") for p in positions}
            await self._reconcile_closed(open_pairs)
            logger.info("Startup reconciliation complete (OANDA open pairs: %s)", open_pairs or "none")
        except Exception as exc:
            logger.error("Startup reconciliation failed: %s", exc)

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
        execution_mode: str = "market",
        spread_pips: float | None = None,
    ) -> UUID:
        async with self._pool.acquire() as conn:
            row = await conn.fetchrow(
                """
                INSERT INTO live_orders
                    (strategy_id, pair, status, direction, size, shadow_mode,
                     execution_mode, spread_pips)
                VALUES ($1, $2, 'pending', $3, $4, false, $5, $6)
                RETURNING id
                """,
                strategy_id, pair, direction, units, execution_mode, spread_pips,
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

    async def _update_order_limit_placed(
        self,
        order_id: UUID,
        oanda_order_id: str | None,
        limit_price: float,
    ) -> None:
        async with self._pool.acquire() as conn:
            await conn.execute(
                """
                UPDATE live_orders
                SET oanda_order_id = $2,
                    limit_price    = $3
                WHERE id = $1
                """,
                order_id, oanda_order_id, limit_price,
            )

    async def _update_order_status(self, order_id: UUID, status: str) -> None:
        async with self._pool.acquire() as conn:
            await conn.execute(
                """
                UPDATE live_orders
                SET status = $2,
                    closed_at = CASE WHEN $2 IN ('cancelled','closed') THEN NOW() ELSE closed_at END
                WHERE id = $1
                """,
                order_id, status,
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
