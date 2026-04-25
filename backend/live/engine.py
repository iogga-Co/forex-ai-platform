"""
Live signal engine (shadow mode).

Subscribes to the Redis tick feed published by live/feed.py, builds 1m and 1H
OHLCV bars via live/bars.py, and checks every active strategy's entry
conditions on each completed bar.

Shadow mode (LIVE_TRADING_ENABLED=false):
  Signals are detected and logged to Redis but NO orders are placed.

When LIVE_TRADING_ENABLED=true (Phase 4 PR3):
  Signals will also be forwarded to live/executor.py.

Signal format published to Redis channel  live:signals :
  {
    "timestamp":     "2026-04-21T10:30:00Z",
    "pair":          "EURUSD",
    "timeframe":     "1H",
    "direction":     "long",
    "strategy_id":   "...",
    "strategy_name": "EMA + RSI momentum",
    "shadow":        true
  }

A capped log of the last SIGNAL_LOG_MAX signals is also kept in
Redis list  live:signal_log  so the frontend can display history on connect.
"""

from __future__ import annotations

import asyncio
import json
import logging
from datetime import datetime

import pandas as pd
import redis.asyncio as aioredis

from core.config import settings
from engine.indicators import (
    adx as calc_adx,
    atr as calc_atr,
    bollinger_bands as calc_bb,
    ema as calc_ema,
    macd as calc_macd,
    rsi as calc_rsi,
    sma as calc_sma,
    stochastic as calc_stoch,
)
from live.bars import BarBuilder, OHLCVBar

logger = logging.getLogger(__name__)

FEED_PAIRS       = ["EURUSD", "GBPUSD", "USDJPY", "EURGBP", "GBPJPY", "USDCHF"]
SIGNAL_CHANNEL   = "live:signals"
SIGNAL_LOG_KEY   = "live:signal_log"
SIGNAL_LOG_MAX   = 50
MIN_BARS         = 50     # minimum ring-buffer depth before running signal checks
STRATEGY_RELOAD  = 300    # seconds between strategy reloads from DB


# ---------------------------------------------------------------------------
# Strategy loading
# ---------------------------------------------------------------------------

async def _load_strategies(pool) -> list[dict]:
    """Fetch all non-deleted strategies with their ir_json from DB."""
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT id, description, ir_json
            FROM strategies
            WHERE deleted_at IS NULL
            ORDER BY created_at DESC
            """
        )
    strategies = []
    for r in rows:
        ir = r["ir_json"]
        if not ir:
            continue
        strategies.append({
            "id":          str(r["id"]),
            "name":        r["description"] or str(r["id"])[:8],
            "ir":          ir,
        })
    logger.info("Engine loaded %d strategies", len(strategies))
    return strategies


# ---------------------------------------------------------------------------
# Signal checking
# ---------------------------------------------------------------------------

def _check_entry_signal(df: pd.DataFrame, entry_conditions: list[dict]) -> bool:
    """
    Return True if ALL entry conditions are satisfied on the last completed bar.

    Uses the same indicator functions as the backtester so live signals
    match backtest signals on equivalent data.
    """
    if df.empty or len(df) < 2:
        return False

    close = df["close"]
    high  = df["high"]
    low   = df["low"]

    for cond in entry_conditions:
        ind = str(cond.get("indicator", "")).upper()
        op  = str(cond.get("operator", ""))
        val = float(cond.get("value") or 0)

        try:
            if ind == "EMA":
                series = calc_ema(close, int(cond.get("period", 20)))
            elif ind == "SMA":
                series = calc_sma(close, int(cond.get("period", 50)))
            elif ind == "RSI":
                series = calc_rsi(close, int(cond.get("period", 14)))
            elif ind == "ATR":
                series = calc_atr(high, low, close, int(cond.get("period", 14)))
            elif ind == "ADX":
                series = calc_adx(high, low, close, int(cond.get("period", 14)))
            elif ind == "MACD":
                fast = int(cond.get("fast") or 12)
                slow = int(cond.get("slow") or 26)
                sig  = int(cond.get("signal_period") or 9)
                series, _, _ = calc_macd(close, fast, slow, sig)
            elif ind == "BB":
                sd   = float(cond.get("std_dev") or 2.0)
                _, _, lower = calc_bb(close, int(cond.get("period", 20)), sd)
                _, _, upper = calc_bb(close, int(cond.get("period", 20)), sd)
                series = upper if op in ("price_below",) else lower
                # full bb check handled per operator below
                _, middle, _ = calc_bb(close, int(cond.get("period", 20)), sd)
                series = middle
            elif ind == "STOCH":
                ks = int(cond.get("k_smooth") or 3)
                dp = int(cond.get("d_period") or 3)
                series, _ = calc_stoch(
                    high, low, close, int(cond.get("period", 14)), ks, dp
                )
            else:
                logger.debug("Unknown indicator in signal check: %s", ind)
                continue

            last = series.iloc[-1]
            if pd.isna(last):
                return False

            if op == ">":
                if not (last > val):
                    return False
            elif op == "<":
                if not (last < val):
                    return False
            elif op == "price_above":
                if not (close.iloc[-1] > last):
                    return False
            elif op == "price_below":
                if not (close.iloc[-1] < last):
                    return False
            elif op == "crossed_above":
                if len(series) < 2 or pd.isna(series.iloc[-2]):
                    return False
                if not (close.iloc[-2] <= series.iloc[-2] and close.iloc[-1] > last):
                    return False
            elif op == "crossed_below":
                if len(series) < 2 or pd.isna(series.iloc[-2]):
                    return False
                if not (close.iloc[-2] >= series.iloc[-2] and close.iloc[-1] < last):
                    return False

        except Exception as exc:
            logger.debug("Signal check error [%s %s]: %s", ind, op, exc)
            return False

    return True


# ---------------------------------------------------------------------------
# Signal publishing
# ---------------------------------------------------------------------------

async def _publish_signal(
    r: aioredis.Redis,
    bar: OHLCVBar,
    strategy: dict,
    atr_value: float,
) -> None:
    shadow = not settings.live_trading_enabled
    signal = {
        "timestamp":     bar.timestamp.isoformat(),
        "pair":          bar.pair,
        "timeframe":     bar.timeframe,
        "direction":     "long",   # Phase 4 PR2: long-only; short added in PR3
        "strategy_id":   strategy["id"],
        "strategy_name": strategy["name"],
        "shadow":        shadow,
        "atr_value":     atr_value,
    }
    payload = json.dumps(signal)
    await r.publish(SIGNAL_CHANNEL, payload)
    # Keep a capped log for page-load history
    await r.lpush(SIGNAL_LOG_KEY, payload)       # type: ignore[misc]
    await r.ltrim(SIGNAL_LOG_KEY, 0, SIGNAL_LOG_MAX - 1)  # type: ignore[misc]
    logger.info(
        "Signal [%s] %s %s strategy=%s shadow=%s",
        bar.timeframe, bar.pair, "long", strategy["name"], shadow,
    )


# ---------------------------------------------------------------------------
# Bar persistence (fire-and-forget via asyncpg)
# ---------------------------------------------------------------------------

async def _persist_bar(pool, bar: OHLCVBar) -> None:
    """Insert a completed live bar into ohlcv_candles (idempotent)."""
    try:
        async with pool.acquire() as conn:
            await conn.execute(
                """
                INSERT INTO ohlcv_candles (pair, timeframe, timestamp, open, high, low, close, volume)
                VALUES ($1, $2, $3, $4, $5, $6, $7, 0)
                ON CONFLICT (pair, timeframe, timestamp) DO NOTHING
                """,
                bar.pair, bar.timeframe, bar.timestamp,
                bar.open, bar.high, bar.low, bar.close,
            )
    except Exception as exc:
        logger.debug("Bar persist failed for %s %s %s: %s", bar.pair, bar.timeframe, bar.timestamp, exc)


# ---------------------------------------------------------------------------
# Per-pair worker
# ---------------------------------------------------------------------------

async def _pair_worker(
    pair: str,
    stop_event: asyncio.Event,
    get_strategies,  # callable() -> list[dict]
    pool,
) -> None:
    """
    Subscribe to Redis ticks for one pair, build 1m+1H bars,
    check all active strategies on each completed bar, publish signals.
    """
    builder_1m = BarBuilder(pair, "1m")
    builder_1h = BarBuilder(pair, "1H")
    r: aioredis.Redis | None = None

    try:
        r = aioredis.from_url(settings.redis_url, decode_responses=True)
        pubsub = r.pubsub()
        await pubsub.subscribe(f"ticks:{pair}")
        logger.info("Engine worker started for %s", pair)

        while not stop_event.is_set():
            msg = await pubsub.get_message(ignore_subscribe_messages=True, timeout=5.0)
            if msg is None:
                continue

            try:
                data = json.loads(msg["data"])
            except Exception:
                continue

            if data.get("type") != "tick":
                continue

            bid = float(data["bid"])
            ask = float(data["ask"])
            tick_time = datetime.fromisoformat(
                data["time"].replace("Z", "+00:00")
            )

            for builder in (builder_1m, builder_1h):
                completed = builder.update(bid, ask, tick_time)
                if completed is None:
                    continue

                # Persist bar to DB (non-blocking)
                asyncio.create_task(_persist_bar(pool, completed))

                # Need enough bars for indicator warmup
                if builder.bar_count < MIN_BARS:
                    continue

                df = builder.to_dataframe()
                strategies = get_strategies()

                for strategy in strategies:
                    entry_conds = strategy["ir"].get("entry_conditions", [])
                    if not entry_conds:
                        continue
                    if _check_entry_signal(df, entry_conds):
                        sl_period = int(
                            (strategy["ir"].get("exit_conditions") or {})
                            .get("stop_loss", {})
                            .get("period", 14)
                        )
                        atr_series = calc_atr(df["high"], df["low"], df["close"], sl_period)
                        atr_val = float(atr_series.iloc[-1]) if not atr_series.empty else 0.0
                        asyncio.create_task(_publish_signal(r, completed, strategy, atr_val))

    except asyncio.CancelledError:
        pass
    except Exception as exc:
        logger.error("Engine worker %s fatal: %s", pair, exc, exc_info=True)
    finally:
        if r is not None:
            try:
                await r.aclose()
            except Exception:
                pass
        logger.info("Engine worker stopped for %s", pair)


# ---------------------------------------------------------------------------
# Top-level engine task
# ---------------------------------------------------------------------------

async def run_engine(stop_event: asyncio.Event, pool) -> None:
    """
    Load strategies from DB and start one worker coroutine per pair.
    Reloads strategies every STRATEGY_RELOAD seconds.
    """
    strategies: list[dict] = []
    last_reload = 0.0

    async def _reload_loop() -> None:
        nonlocal strategies, last_reload
        import time
        while not stop_event.is_set():
            now = time.monotonic()
            if now - last_reload >= STRATEGY_RELOAD:
                try:
                    strategies = await _load_strategies(pool)
                    last_reload = now
                except Exception as exc:
                    logger.warning("Strategy reload failed: %s", exc)
            await asyncio.sleep(30)

    def get_strategies() -> list[dict]:
        return strategies

    # Initial load
    try:
        strategies = await _load_strategies(pool)
        import time
        last_reload = time.monotonic()
    except Exception as exc:
        logger.warning("Initial strategy load failed: %s", exc)

    reload_task = asyncio.create_task(_reload_loop(), name="engine-reload")
    pair_tasks  = [
        asyncio.create_task(
            _pair_worker(pair, stop_event, get_strategies, pool),
            name=f"engine-{pair}",
        )
        for pair in FEED_PAIRS
    ]

    logger.info("Signal engine started (%d strategies, %d pairs)", len(strategies), len(FEED_PAIRS))

    await stop_event.wait()

    reload_task.cancel()
    for t in pair_tasks:
        t.cancel()
    await asyncio.gather(reload_task, *pair_tasks, return_exceptions=True)
    logger.info("Signal engine stopped")
