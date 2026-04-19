"""
G-Optimize Celery task.

Orchestrates random parameter search: samples strategy configurations from a
user-defined space, backtests each against historical data, stores results,
and optionally injects passing strategies into the RAG corpus via Voyage AI.
"""

import json
import logging
import random
from datetime import datetime, timezone

import psycopg2
import psycopg2.extras
import redis

from core.celery_app import celery_app
from core.config import settings
from data import db as data_db
from engine.runner import run_backtest
from engine.sir import StrategyIR

logger = logging.getLogger(__name__)

_STOP_KEY     = "g_optimize:stop:{run_id}"
_SSE_CHANNEL  = "g_optimize:progress:{run_id}"

# ---------------------------------------------------------------------------
# Redis helper
# ---------------------------------------------------------------------------

def _get_redis() -> redis.Redis:
    return redis.Redis.from_url(settings.redis_url, decode_responses=True)


# ---------------------------------------------------------------------------
# Sampling helpers
# ---------------------------------------------------------------------------

def _sample_step(min_val: int, max_val: int, step: int = 1) -> int:
    """Pick a random integer from [min_val, max_val] at intervals of step."""
    step = max(1, int(step))
    values = list(range(int(min_val), int(max_val) + 1, step))
    return random.choice(values) if values else int(min_val)


def _sample_float_step(min_val: float, max_val: float, step: float = 0.5) -> float:
    """Pick a random float from [min_val, max_val] at intervals of step."""
    step = max(0.01, float(step))
    n = round((float(max_val) - float(min_val)) / step)
    if n <= 0:
        return float(min_val)
    return round(float(min_val) + random.randint(0, n) * step, 6)


# ---------------------------------------------------------------------------
# ConfigSampler
# ---------------------------------------------------------------------------

class ConfigSampler:
    """
    Generates random but valid StrategyIR dicts from the parameter space
    defined in entry_config / exit_config (stored as JSONB on g_optimize_runs).
    """

    def __init__(self, entry_config: dict, exit_config: dict) -> None:
        self._entry = entry_config
        self._exit  = exit_config

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def sample(self) -> dict:
        """Return a random SIR dict.  Raises ValueError on unsolvable R:R."""
        entry_conditions = self._sample_entry_conditions()
        exit_mode        = self._exit.get("exit_mode", "stops_only")
        indicator_exits  = self._sample_indicator_exits(exit_mode)
        sl               = self._sample_stop(self._exit.get("sl", {}))
        tp               = self._sample_tp_with_rr_floor(sl)
        trailing         = self._sample_trailing(self._exit.get("trailing", {}))

        ec: dict = {
            "stop_loss":   sl,
            "take_profit": tp,
            "exit_mode":   exit_mode,
            "indicator_exits": indicator_exits,
        }
        if trailing.get("enabled"):
            ec["trailing_stop"] = trailing

        return {
            "entry_conditions": entry_conditions,
            "exit_conditions":  ec,
            "filters":          {"exclude_days": [], "session": "all"},
            "position_sizing":  {"risk_per_trade_pct": 1.0, "max_size_units": 100_000},
        }

    # ------------------------------------------------------------------
    # Entry / exit conditions
    # ------------------------------------------------------------------

    def _sample_entry_conditions(self) -> list[dict]:
        conditions = self._entry.get("conditions", [])
        max_n = max(1, int(self._entry.get("max_conditions", 3)))
        if not conditions:
            return []
        n = random.randint(1, min(max_n, len(conditions)))
        selected = random.sample(conditions, n)
        return [self._sample_condition(c) for c in selected]

    def _sample_indicator_exits(self, exit_mode: str) -> list[dict]:
        if exit_mode == "stops_only":
            return []
        cfgs = self._exit.get("indicator_exits", [])
        if not cfgs:
            return []
        n = random.randint(0, len(cfgs))
        if n == 0:
            return []
        return [self._sample_condition(c) for c in random.sample(cfgs, n)]

    def _sample_condition(self, cfg: dict) -> dict:
        """Sample concrete parameter values for one indicator condition spec."""
        indicator = cfg["indicator"]
        operator  = cfg["operator"]
        cond: dict = {"indicator": indicator, "operator": operator}

        if indicator == "MACD":
            fast = random.randint(int(cfg.get("fast_min", 8)),  int(cfg.get("fast_max", 16)))
            slow = random.randint(int(cfg.get("slow_min", 20)), int(cfg.get("slow_max", 32)))
            # Ensure fast < slow
            if fast >= slow:
                fast, slow = min(fast, slow), max(fast, slow)
                if fast == slow:
                    slow = fast + 1
            cond["fast"]          = fast
            cond["slow"]          = slow
            cond["signal_period"] = random.randint(int(cfg.get("signal_min", 7)), int(cfg.get("signal_max", 12)))
            cond["component"]     = cfg.get("component", "histogram")
            cond["period"]        = 26  # unused for MACD but satisfies Pydantic default

        elif indicator == "STOCH":
            cond["period"]   = 14   # k_period
            cond["k_smooth"] = _sample_step(int(cfg.get("k_min", 3)),  int(cfg.get("k_max", 14)))
            cond["d_period"] = _sample_step(int(cfg.get("d_min", 3)),  int(cfg.get("d_max", 5)))
            cond["component"] = cfg.get("component", "k")

        elif indicator == "BB":
            cond["period"]  = _sample_step(
                int(cfg.get("period_min", 10)), int(cfg.get("period_max", 30)),
                int(cfg.get("period_step", 5)),
            )
            cond["std_dev"]   = round(random.uniform(
                float(cfg.get("std_dev_min", 1.5)), float(cfg.get("std_dev_max", 3.0))
            ), 1)
            cond["component"] = cfg.get("component", "upper")

        else:
            cond["period"] = _sample_step(
                int(cfg.get("period_min", 10)), int(cfg.get("period_max", 20)),
                int(cfg.get("period_step", 5)),
            )

        if operator in (">", "<", "crossed_above", "crossed_below"):
            cond["value"] = round(random.uniform(
                float(cfg.get("value_min", 0)), float(cfg.get("value_max", 100))
            ), 2)

        return cond

    # ------------------------------------------------------------------
    # Stop / TP / trailing
    # ------------------------------------------------------------------

    def _sample_stop(self, cfg: dict) -> dict:
        stop_type = cfg.get("type", "atr")
        if stop_type == "atr":
            return {
                "type":       "atr",
                "period":     int(cfg.get("period", 14)),
                "multiplier": _sample_float_step(
                    float(cfg.get("multiplier_min", 1.0)),
                    float(cfg.get("multiplier_max", 3.0)),
                    float(cfg.get("multiplier_step", 0.5)),
                ),
            }
        pips = round(random.uniform(
            float(cfg.get("pips_min", 10)), float(cfg.get("pips_max", 50))
        ))
        return {"type": "fixed_pips", "pips": pips}

    def _sample_tp_with_rr_floor(self, sl: dict) -> dict:
        """Sample TP, resampling up to 20 times to satisfy the R:R floor."""
        rr_floor = float(self._exit.get("rr_floor", 1.5))
        tp_cfg   = self._exit.get("tp", {})
        for _ in range(20):
            tp = self._sample_stop(tp_cfg)
            if sl["type"] == "atr" and tp["type"] == "atr":
                if tp["multiplier"] >= rr_floor * sl["multiplier"]:
                    return tp
            else:
                return tp  # non-ATR stops: skip R:R check
        # Fallback: force minimum TP
        if sl["type"] == "atr" and tp_cfg.get("type", "atr") == "atr":
            min_mult = round(rr_floor * sl["multiplier"] + 0.5, 6)
            return {"type": "atr", "period": int(tp_cfg.get("period", 14)), "multiplier": min_mult}
        return self._sample_stop(tp_cfg)

    def _sample_trailing(self, cfg: dict) -> dict:
        if not cfg.get("enabled", False):
            return {"enabled": False}
        ts_type = cfg.get("type", "atr")
        period  = int(cfg.get("period", 14))
        if ts_type == "atr":
            return {
                "enabled":               True,
                "type":                  "atr",
                "period":                period,
                "multiplier":            _sample_float_step(
                    float(cfg.get("multiplier_min", 1.0)),
                    float(cfg.get("multiplier_max", 2.0)),
                    0.1,
                ),
                "activation_multiplier": _sample_float_step(
                    float(cfg.get("activation_min", 1.0)),
                    float(cfg.get("activation_max", 2.0)),
                    0.1,
                ),
            }
        pips = round(random.uniform(float(cfg.get("pips_min", 10)), float(cfg.get("pips_max", 30))))
        return {
            "enabled":               True,
            "type":                  "fixed_pips",
            "pips":                  pips,
            "activation_multiplier": _sample_float_step(
                float(cfg.get("activation_min", 1.0)),
                float(cfg.get("activation_max", 2.0)),
                0.1,
            ),
        }


# ---------------------------------------------------------------------------
# DB helpers (sync / psycopg2)
# ---------------------------------------------------------------------------

def _fetch_run(conn: psycopg2.extensions.connection, run_id: str) -> dict | None:
    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute(
            """
            SELECT id, user_id, pairs, timeframe, period_start, period_end,
                   n_configs, store_trades,
                   entry_config, exit_config,
                   threshold_sharpe, threshold_win_rate,
                   threshold_max_dd, threshold_min_trades,
                   auto_rag, status
            FROM g_optimize_runs
            WHERE id = %s
            """,
            (run_id,),
        )
        row = cur.fetchone()
    return dict(row) if row else None


def _set_running(conn: psycopg2.extensions.connection, run_id: str, total: int) -> None:
    with conn.cursor() as cur:
        cur.execute(
            """
            UPDATE g_optimize_runs
            SET status = 'running', started_at = NOW(), configs_total = %s
            WHERE id = %s
            """,
            (total, run_id),
        )
    conn.commit()


def _increment_progress(
    conn: psycopg2.extensions.connection,
    run_id: str,
    passed: bool,
) -> None:
    with conn.cursor() as cur:
        if passed:
            cur.execute(
                """
                UPDATE g_optimize_runs
                SET configs_done = configs_done + 1,
                    configs_passed = configs_passed + 1
                WHERE id = %s
                """,
                (run_id,),
            )
        else:
            cur.execute(
                """
                UPDATE g_optimize_runs
                SET configs_done = configs_done + 1,
                    configs_failed = configs_failed + 1
                WHERE id = %s
                """,
                (run_id,),
            )
    conn.commit()


def _set_final_status(
    conn: psycopg2.extensions.connection,
    run_id: str,
    status: str,
) -> None:
    with conn.cursor() as cur:
        cur.execute(
            """
            UPDATE g_optimize_runs
            SET status = %s, completed_at = NOW()
            WHERE id = %s
            """,
            (status, run_id),
        )
    conn.commit()


def _set_error(
    conn: psycopg2.extensions.connection,
    run_id: str,
    message: str,
) -> None:
    with conn.cursor() as cur:
        cur.execute(
            """
            UPDATE g_optimize_runs
            SET status = 'failed', error_message = %s, completed_at = NOW()
            WHERE id = %s
            """,
            (message[:2000], run_id),
        )
    conn.commit()


# ---------------------------------------------------------------------------
# RAG injection
# ---------------------------------------------------------------------------

def _build_rag_description(
    sir_json: dict,
    metrics: dict,
    pair: str,
    timeframe: str,
) -> str:
    """Human-readable description used as the embeddable RAG document."""
    entry = sir_json.get("entry_conditions", [])
    exits = sir_json.get("exit_conditions", {})
    sl    = exits.get("stop_loss", {})
    tp    = exits.get("take_profit", {})

    def _cond_str(c: dict) -> str:
        ind = c.get("indicator", "?")
        if ind == "MACD":
            return f"MACD({c.get('fast')}/{c.get('slow')}/{c.get('signal_period')})"
        if ind == "BB":
            return f"BB({c.get('period')},{c.get('std_dev',2)}σ)"
        if ind == "STOCH":
            return f"STOCH({c.get('k_smooth')}/{c.get('d_period')})"
        return f"{ind}({c.get('period')})"

    entry_str = " + ".join(_cond_str(c) for c in entry)
    sl_str = f"SL ATR×{sl.get('multiplier','?')}" if sl.get("type") == "atr" else f"SL {sl.get('pips')}pips"
    tp_str = f"TP ATR×{tp.get('multiplier','?')}" if tp.get("type") == "atr" else f"TP {tp.get('pips')}pips"

    sharpe   = metrics.get("sharpe") or 0
    win_rate = (metrics.get("win_rate") or 0) * 100
    max_dd   = abs(metrics.get("max_dd") or 0) * 100
    trades   = metrics.get("trade_count") or 0

    return (
        f"[G-Opt] {pair} {timeframe}: {entry_str}. {sl_str}. {tp_str}. "
        f"Sharpe={sharpe:.2f} WR={win_rate:.1f}% MaxDD={max_dd:.1f}% Trades={trades}. "
        f"Source: G-Optimize automated discovery."
    )


def _embed_and_inject_rag(
    backtest_run_id: str,
    sir_json: dict,
    metrics: dict,
    pair: str,
    timeframe: str,
) -> None:
    """
    Save passing strategy to strategies table, embed via Voyage AI,
    store in pgvector, and link backtest_run.strategy_id.
    Runs synchronously inside the Celery worker via asyncio.run().
    """
    import asyncio
    from datetime import date as _date
    from ai.voyage_client import embed as voyage_embed

    description = _build_rag_description(sir_json, metrics, pair, timeframe)

    # Tag IR with g_optimize provenance
    sir_tagged = dict(sir_json)
    meta = dict(sir_tagged.get("metadata", {}))
    meta.update({"source": "g_optimize", "pair": pair, "timeframe": timeframe})
    sir_tagged["metadata"] = meta

    # Embed (async → sync)
    embedding: list[float] | None = None
    try:
        embedding = asyncio.run(voyage_embed(description))
    except Exception as exc:
        logger.warning("Voyage embed failed for bt_run %s: %s — storing without embedding", backtest_run_id, exc)

    embedding_str: str | None = None
    if embedding:
        embedding_str = "[" + ",".join(str(x) for x in embedding) + "]"

    with data_db.get_sync_conn(settings.database_url) as conn:
        with conn.cursor() as cur:
            if embedding_str:
                cur.execute(
                    """
                    INSERT INTO strategies (version, ir_json, description, pair, timeframe, embedding)
                    VALUES (1, %s, %s, %s, %s, %s::vector)
                    RETURNING id
                    """,
                    (psycopg2.extras.Json(sir_tagged), description, pair, timeframe, embedding_str),
                )
            else:
                cur.execute(
                    """
                    INSERT INTO strategies (version, ir_json, description, pair, timeframe)
                    VALUES (1, %s, %s, %s, %s)
                    RETURNING id
                    """,
                    (psycopg2.extras.Json(sir_tagged), description, pair, timeframe),
                )
            strategy_id = str(cur.fetchone()[0])

        with conn.cursor() as cur:
            cur.execute(
                "UPDATE backtest_runs SET strategy_id = %s WHERE id = %s",
                (strategy_id, backtest_run_id),
            )
        conn.commit()

    logger.info(
        "RAG injected: strategy=%s bt_run=%s pair=%s sharpe=%.3f",
        strategy_id, backtest_run_id, pair, metrics.get("sharpe") or 0,
    )


# ---------------------------------------------------------------------------
# Threshold evaluation
# ---------------------------------------------------------------------------

def _passes_threshold(metrics: dict, run: dict) -> bool:
    """Return True if the backtest result meets all passing thresholds."""
    sharpe     = float(metrics.get("sharpe") or 0)
    win_rate   = float(metrics.get("win_rate") or 0)   # 0-1 fraction
    max_dd     = abs(float(metrics.get("max_dd") or 1)) # vectorbt returns negative
    trade_count = int(metrics.get("trade_count") or 0)

    return (
        sharpe     >= float(run["threshold_sharpe"])
        and win_rate * 100 >= float(run["threshold_win_rate"])
        and max_dd  * 100 <= float(run["threshold_max_dd"])
        and trade_count    >= int(run["threshold_min_trades"])
    )


# ---------------------------------------------------------------------------
# SSE publishing
# ---------------------------------------------------------------------------

def _publish_progress(
    r: redis.Redis,
    run_id: str,
    configs_done: int,
    configs_total: int,
    configs_passed: int,
) -> None:
    try:
        r.publish(
            _SSE_CHANNEL.format(run_id=run_id),
            json.dumps({
                "event":          "progress",
                "configs_done":   configs_done,
                "configs_total":  configs_total,
                "configs_passed": configs_passed,
            }),
        )
    except Exception:
        pass  # SSE is best-effort


def _publish_done(r: redis.Redis, run_id: str, status: str) -> None:
    try:
        r.publish(
            _SSE_CHANNEL.format(run_id=run_id),
            json.dumps({"event": "done", "status": status}),
        )
    except Exception:
        pass


# ---------------------------------------------------------------------------
# Celery task
# ---------------------------------------------------------------------------

@celery_app.task(
    bind=True,
    name="tasks.g_optimize.run",
    soft_time_limit=28_800,   # 8 h — fires SoftTimeLimitExceeded
    time_limit=32_400,        # 9 h — SIGKILL
)
def run_g_optimize(self, run_id: str) -> dict:
    """
    Main G-Optimize discovery loop.

    1. Fetch run config from DB.
    2. Pre-fetch OHLCV candles for all pairs (once — reused across all configs).
    3. Loop n_configs times:
       a. Check Redis stop signal.
       b. Sample a random valid SIR.
       c. For each pair: run backtest, store result, inject RAG if passing.
       d. Publish SSE progress event.
    4. Mark run done/stopped/failed.
    """
    r = _get_redis()
    logger.info("G-Optimize run %s started", run_id)

    # ── Fetch run config ────────────────────────────────────────────────────
    try:
        with data_db.get_sync_conn(settings.database_url) as conn:
            run = _fetch_run(conn, run_id)
    except Exception as exc:
        logger.exception("Failed to fetch G-Optimize run %s: %s", run_id, exc)
        return {"status": "error", "error": str(exc)}

    if run is None:
        logger.error("G-Optimize run %s not found", run_id)
        return {"status": "error", "error": "run not found"}

    pairs       = list(run["pairs"])
    n_configs   = int(run["n_configs"])
    store_trades_mode = run["store_trades"]  # 'passing' | 'all' | 'none'
    configs_total = n_configs * len(pairs)

    period_start_dt = datetime.combine(run["period_start"], datetime.min.time()).replace(tzinfo=timezone.utc)
    period_end_dt   = datetime.combine(run["period_end"],   datetime.min.time()).replace(tzinfo=timezone.utc)

    # Mark as running; set configs_total
    with data_db.get_sync_conn(settings.database_url) as conn:
        _set_running(conn, run_id, configs_total)

    # ── Pre-fetch OHLCV for all pairs ───────────────────────────────────────
    pair_candles: dict = {}
    for pair in pairs:
        try:
            with data_db.get_sync_conn(settings.database_url) as conn:
                df = data_db.fetch_candles(
                    conn, pair=pair, timeframe=run["timeframe"],
                    start=period_start_dt, end=period_end_dt,
                )
            if df.empty:
                logger.warning("No OHLCV data for %s %s — pair skipped", pair, run["timeframe"])
            else:
                pair_candles[pair] = df
        except Exception as exc:
            logger.warning("OHLCV fetch failed for %s: %s", pair, exc)

    if not pair_candles:
        with data_db.get_sync_conn(settings.database_url) as conn:
            _set_error(conn, run_id, "No OHLCV data available for any pair in the requested period.")
        return {"status": "error", "error": "no data"}

    # ── Main sampling loop ──────────────────────────────────────────────────
    sampler      = ConfigSampler(run["entry_config"], run["exit_config"])
    configs_done = 0
    configs_passed = 0

    try:
        for config_idx in range(n_configs):

            # Check stop signal
            if r.exists(_STOP_KEY.format(run_id=run_id)):
                logger.info("G-Optimize run %s stopped by user at config %d", run_id, config_idx)
                with data_db.get_sync_conn(settings.database_url) as conn:
                    _set_final_status(conn, run_id, "stopped")
                _publish_done(r, run_id, "stopped")
                return {"status": "stopped", "configs_done": configs_done}

            # Sample SIR
            try:
                sir_dict = sampler.sample()
                sir = StrategyIR.model_validate(sir_dict)
            except Exception as exc:
                logger.debug("Config %d invalid after sampling: %s", config_idx, exc)
                continue

            # Backtest each pair with this SIR
            for pair, df in pair_candles.items():
                try:
                    result = run_backtest(df, sir, pair=pair, timeframe=run["timeframe"])
                    passed = _passes_threshold(result.metrics, run)

                    do_store_trades = (
                        store_trades_mode == "all"
                        or (store_trades_mode == "passing" and passed)
                    )

                    with data_db.get_sync_conn(settings.database_url) as conn:
                        bt_run_id = data_db.insert_g_optimize_backtest_run(
                            conn,
                            g_optimize_run_id=run_id,
                            pair=pair,
                            timeframe=run["timeframe"],
                            period_start=str(run["period_start"]),
                            period_end=str(run["period_end"]),
                            sir_json=sir_dict,
                            metrics=result.metrics,
                            passed_threshold=passed,
                        )
                        if do_store_trades:
                            data_db.bulk_insert_trades(conn, bt_run_id, result.trades)
                        _increment_progress(conn, run_id, passed=passed)

                    if passed:
                        configs_passed += 1
                        if run["auto_rag"]:
                            _embed_and_inject_rag(
                                bt_run_id, sir_dict, result.metrics, pair, run["timeframe"]
                            )

                    configs_done += 1

                except Exception as exc:
                    logger.warning(
                        "Backtest error at config %d pair %s: %s", config_idx, pair, exc
                    )
                    configs_done += 1

            # Publish SSE progress every 50 backtests
            if configs_done % 50 == 0:
                _publish_progress(r, run_id, configs_done, configs_total, configs_passed)

    except Exception as exc:
        logger.exception("G-Optimize run %s fatal error: %s", run_id, exc)
        with data_db.get_sync_conn(settings.database_url) as conn:
            _set_error(conn, run_id, str(exc))
        _publish_done(r, run_id, "failed")
        raise

    # ── Mark done ───────────────────────────────────────────────────────────
    with data_db.get_sync_conn(settings.database_url) as conn:
        _set_final_status(conn, run_id, "done")
    _publish_done(r, run_id, "done")

    logger.info(
        "G-Optimize run %s done: %d/%d backtests, %d passed",
        run_id, configs_done, configs_total, configs_passed,
    )
    return {"status": "done", "configs_done": configs_done, "configs_passed": configs_passed}
