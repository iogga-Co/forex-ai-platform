"""
Celery optimization task — AI-driven iterative strategy improvement loop.

Flow per iteration
------------------
1.  Check stop-signal in Redis (user pressed Stop)
2.  Run a full backtest with the current IR
3.  Persist the iteration to optimization_iterations
4.  Publish SSE progress event to Redis channel opt:progress:{run_id}
5.  Check stopping conditions (target metrics, max_iterations, time_limit)
6.  Call analyze_and_mutate() → Claude proposes IR changes via tool use
7.  Update optimization_runs.best_* if this iteration beat the prior best
8.  Repeat until a stopping condition triggers

On completion
-------------
- Saves the best IR as a new strategy row
- Updates optimization_runs.status, best_*, completed_at, stop_reason

Safety
------
- Redis key  opt:stop:{run_id}  checked at the top of every iteration
- Celery soft time limit: 650 min (10 min over the max 600 min UI limit)
- Degenerate detection via build_extra_context (0 trades / unchanged results)
- Pydantic IR validation with retry inside analyze_and_mutate
"""

import json
import logging

import psycopg2
import redis

from ai.optimization_agent import analyze_and_mutate, build_extra_context
from core.celery_app import celery_app
from core.config import settings
from data import db as data_db
from engine.runner import run_backtest
from engine.sir import StrategyIR

logger = logging.getLogger(__name__)

# Redis key patterns
_STOP_KEY = "opt:stop:{run_id}"
_SSE_CHANNEL = "opt:progress:{run_id}"

# Celery soft/hard time limits (seconds)
_SOFT_LIMIT = 39_000   # 650 min — fires SoftTimeLimitExceeded (clean shutdown)
_HARD_LIMIT = 39_600   # 660 min — SIGKILL


def _get_redis() -> redis.Redis:
    return redis.Redis.from_url(settings.redis_url, decode_responses=True)


# ---------------------------------------------------------------------------
# SSE publishing
# ---------------------------------------------------------------------------

def _publish(r: redis.Redis, run_id: str, event: str, data: dict) -> None:
    """Publish a JSON event to the per-run SSE channel.  Best-effort."""
    try:
        r.publish(
            _SSE_CHANNEL.format(run_id=run_id),
            json.dumps({"event": event, **data}),
        )
    except Exception:
        logger.warning("Redis publish failed for opt run %s event %s", run_id, event)


# ---------------------------------------------------------------------------
# DB helpers (all sync / psycopg2)
# ---------------------------------------------------------------------------

def _fetch_run(conn: psycopg2.extensions.connection, run_id: str) -> dict | None:
    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute(
            """
            SELECT id, pair, timeframe, period_start, period_end,
                   initial_strategy_id, system_prompt, user_prompt,
                   max_iterations, time_limit_minutes,
                   target_win_rate, target_sharpe,
                   current_iteration, status, model
            FROM optimization_runs
            WHERE id = %s
            """,
            (run_id,),
        )
        row = cur.fetchone()
    return dict(row) if row else None


def _set_run_running(conn: psycopg2.extensions.connection, run_id: str, celery_task_id: str) -> None:
    """
    Stamp the Celery task ID once the worker picks up the run.
    Status is already 'running' — set by the API at enqueue time.
    """
    with conn.cursor() as cur:
        cur.execute(
            "UPDATE optimization_runs SET celery_task_id = %s WHERE id = %s",
            (celery_task_id, run_id),
        )
    conn.commit()


def _insert_iteration(
    conn: psycopg2.extensions.connection,
    run_id: str,
    iteration_number: int,
    ir: dict,
    backtest_run_id: str,
    metrics: dict,
    ai_analysis: str,
    ai_changes: str,
) -> str:
    with conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO optimization_iterations (
                run_id, iteration_number, strategy_ir, backtest_run_id,
                sharpe, win_rate, max_dd, total_pnl, trade_count,
                ai_analysis, ai_changes
            )
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            ON CONFLICT (run_id, iteration_number) DO NOTHING
            RETURNING id
            """,
            (
                run_id,
                iteration_number,
                json.dumps(ir),
                backtest_run_id,
                metrics.get("sharpe"),
                metrics.get("win_rate"),
                metrics.get("max_dd"),
                metrics.get("total_pnl"),
                metrics.get("trade_count"),
                ai_analysis,
                ai_changes,
            ),
        )
        row = cur.fetchone()
    conn.commit()
    return str(row[0]) if row else ""


def _update_best(
    conn: psycopg2.extensions.connection,
    run_id: str,
    iteration: int,
    backtest_run_id: str,
    sharpe: float,
    win_rate: float,
) -> None:
    with conn.cursor() as cur:
        cur.execute(
            """
            UPDATE optimization_runs
            SET best_iteration = %s,
                best_backtest_id = %s,
                best_sharpe = %s,
                best_win_rate = %s,
                current_iteration = %s
            WHERE id = %s
            """,
            (iteration, backtest_run_id, sharpe, win_rate, iteration, run_id),
        )
    conn.commit()


def _update_current_iteration(
    conn: psycopg2.extensions.connection,
    run_id: str,
    iteration: int,
) -> None:
    with conn.cursor() as cur:
        cur.execute(
            "UPDATE optimization_runs SET current_iteration = %s WHERE id = %s",
            (iteration, run_id),
        )
    conn.commit()


def _complete_run(
    conn: psycopg2.extensions.connection,
    run_id: str,
    stop_reason: str,
) -> None:
    with conn.cursor() as cur:
        cur.execute(
            """
            UPDATE optimization_runs
            SET status = 'completed',
                stop_reason = %s,
                completed_at = NOW()
            WHERE id = %s
            """,
            (stop_reason, run_id),
        )
    conn.commit()


def _fail_run(conn: psycopg2.extensions.connection, run_id: str, reason: str) -> None:
    with conn.cursor() as cur:
        cur.execute(
            """
            UPDATE optimization_runs
            SET status = 'failed', stop_reason = %s, completed_at = NOW()
            WHERE id = %s
            """,
            (reason, run_id),
        )
    conn.commit()


# ---------------------------------------------------------------------------
# Celery task
# ---------------------------------------------------------------------------

@celery_app.task(
    bind=True,
    name="tasks.optimization.run",
    queue="optimization",
    soft_time_limit=_SOFT_LIMIT,
    time_limit=_HARD_LIMIT,
    max_retries=0,  # optimization runs are not retried — state is in DB
)
def run_optimization_task(self, run_id: str) -> dict:
    """
    Execute an AI-driven optimization loop for the given optimization_run UUID.

    The task is enqueued by POST /api/optimization/runs/{id}/start.
    Progress is published to Redis channel opt:progress:{run_id} and consumed
    by the SSE endpoint GET /api/optimization/runs/{id}/stream.
    """
    celery_task_id = self.request.id
    r = _get_redis()

    try:
        from celery.exceptions import SoftTimeLimitExceeded
    except ImportError:
        SoftTimeLimitExceeded = Exception  # fallback (never hit in practice)

    try:
        with data_db.get_sync_conn(settings.database_url) as conn:
            run = _fetch_run(conn, run_id)

        if run is None:
            logger.error("Optimization run %s not found", run_id)
            return {"status": "failed", "reason": "run not found"}

        with data_db.get_sync_conn(settings.database_url) as conn:
            _set_run_running(conn, run_id, celery_task_id)

        # ----------------------------------------------------------------
        # Load initial IR
        # ----------------------------------------------------------------
        initial_strategy_id = str(run["initial_strategy_id"])
        with data_db.get_sync_conn(settings.database_url) as conn:
            ir_json = data_db.fetch_strategy_ir(conn, initial_strategy_id)

        if ir_json is None:
            raise ValueError(f"Initial strategy {initial_strategy_id!r} not found")

        StrategyIR.model_validate(ir_json)  # fail fast if IR is malformed

        pair = run["pair"]
        timeframe = run["timeframe"]
        period_start_str = run["period_start"].isoformat()
        period_end_str = run["period_end"].isoformat()
        max_iterations: int = run["max_iterations"]
        time_limit_sec: float = run["time_limit_minutes"] * 60.0
        target_win_rate: float | None = float(run["target_win_rate"]) if run["target_win_rate"] else None
        target_sharpe: float | None = float(run["target_sharpe"]) if run["target_sharpe"] else None
        system_prompt: str = run["system_prompt"] or ""
        user_prompt: str = run["user_prompt"] or ""
        model: str = run.get("model") or "claude-opus-4-6"

        # ----------------------------------------------------------------
        # Fetch price data once (reused every iteration)
        # ----------------------------------------------------------------
        from datetime import datetime, timezone
        start_dt = datetime.fromisoformat(period_start_str).replace(tzinfo=timezone.utc)
        end_dt = datetime.fromisoformat(period_end_str).replace(tzinfo=timezone.utc)

        with data_db.get_sync_conn(settings.database_url) as conn:
            df = data_db.fetch_candles(conn, pair=pair, timeframe=timeframe,
                                        start=start_dt, end=end_dt)

        if df.empty:
            raise ValueError(
                f"No price data for {pair} {timeframe} {period_start_str} → {period_end_str}"
            )

        _publish(r, run_id, "start", {
            "run_id": run_id,
            "max_iterations": max_iterations,
            "msg": f"Loaded {len(df)} bars for {pair} {timeframe}",
        })

        # ----------------------------------------------------------------
        # Optimization loop state
        # ----------------------------------------------------------------
        current_ir = ir_json
        conversation: list[dict] = []
        iteration_history: list[dict] = []
        best_sharpe: float = float("-inf")
        best_win_rate: float = 0.0
        best_backtest_id: str | None = None
        best_iteration: int = 0
        stop_reason: str = "max_iterations"
        started_at = datetime.now(tz=timezone.utc)

        prev_trade_count: int = 0
        prev_sharpe: float = 0.0

        # ----------------------------------------------------------------
        # Main loop
        # ----------------------------------------------------------------
        for iteration in range(1, max_iterations + 1):

            # 1. Check user stop-signal
            if r.exists(_STOP_KEY.format(run_id=run_id)):
                r.delete(_STOP_KEY.format(run_id=run_id))
                stop_reason = "user_stopped"
                logger.info("Optimization run %s stopped by user at iteration %d", run_id, iteration)
                break

            # 2. Check time limit
            elapsed = (datetime.now(tz=timezone.utc) - started_at).total_seconds()
            if elapsed >= time_limit_sec:
                stop_reason = "time_limit"
                logger.info("Optimization run %s hit time limit at iteration %d", run_id, iteration)
                break

            logger.info("Optimization run %s — iteration %d/%d", run_id, iteration, max_iterations)

            _publish(r, run_id, "iteration_start", {
                "iteration": iteration,
                "max_iterations": max_iterations,
                "msg": f"Iteration {iteration}/{max_iterations} — running backtest",
            })

            # 3. Run backtest
            sir = StrategyIR.model_validate(current_ir)
            result = run_backtest(
                df=df,
                sir=sir,
                pair=pair,
                timeframe=timeframe,
                initial_capital=100_000.0,
                progress_callback=None,
            )
            metrics = result.metrics
            trades = result.trades

            # 4. Persist backtest run
            run_record = {
                "strategy_id": initial_strategy_id,
                "period_start": period_start_str,
                "period_end": period_end_str,
                "pair": pair,
                "timeframe": timeframe,
                "celery_task_id": None,  # not deduped by task_id for opt iterations
                **metrics,
            }
            with data_db.get_sync_conn(settings.database_url) as conn:
                backtest_run_id = data_db.insert_backtest_run(conn, run_record)
                data_db.bulk_insert_trades(conn, backtest_run_id, trades)

            sharpe = float(metrics.get("sharpe") or 0.0)
            win_rate = float(metrics.get("win_rate") or 0.0)
            trade_count = int(metrics.get("trade_count") or 0)

            # 5. Track best result
            is_best = sharpe > best_sharpe
            if is_best:
                best_sharpe = sharpe
                best_win_rate = win_rate
                best_backtest_id = backtest_run_id
                best_iteration = iteration

                with data_db.get_sync_conn(settings.database_url) as conn:
                    _update_best(conn, run_id, iteration, backtest_run_id, sharpe, win_rate)

            # 6. Build degenerate-detection context for Claude
            extra_context = build_extra_context(
                trade_count=trade_count,
                prev_trade_count=prev_trade_count,
                sharpe=sharpe,
                prev_sharpe=prev_sharpe,
            )

            # 7. Call Claude to analyse and propose mutations
            trades_summary = [
                {
                    "direction": t.get("direction"),
                    "entry_price": t.get("entry_price"),
                    "exit_price": t.get("exit_price"),
                    "pnl": t.get("pnl"),
                }
                for t in trades[:10]
            ]

            updated_ir, ai_analysis, ai_changes = analyze_and_mutate(
                current_ir=current_ir,
                metrics=metrics,
                trades_summary=trades_summary,
                iteration_history=iteration_history,
                user_system_prompt=system_prompt,
                user_prompt=user_prompt,
                conversation=conversation,
                extra_context=extra_context,
                model=model,
            )

            # 8. Persist iteration record
            with data_db.get_sync_conn(settings.database_url) as conn:
                _insert_iteration(
                    conn=conn,
                    run_id=run_id,
                    iteration_number=iteration,
                    ir=current_ir,
                    backtest_run_id=backtest_run_id,
                    metrics=metrics,
                    ai_analysis=ai_analysis,
                    ai_changes=ai_changes,
                )
                _update_current_iteration(conn, run_id, iteration)

            # 9. Publish iteration-complete SSE event
            _publish(r, run_id, "iteration_complete", {
                "iteration": iteration,
                "max_iterations": max_iterations,
                "sharpe": sharpe,
                "win_rate": win_rate,
                "trade_count": trade_count,
                "is_best": is_best,
                "ai_analysis": ai_analysis,
                "ai_changes": ai_changes,
                "msg": f"Iteration {iteration} complete — Sharpe {sharpe:.3f}",
            })

            # 10. Append to iteration history (for Claude's next context window)
            iteration_history.append({
                "iteration": iteration,
                "sharpe": sharpe,
                "win_rate": win_rate,
                "ai_changes": ai_changes,
            })

            # Append assistant turn to conversation for multi-turn context
            conversation.append({"role": "user", "content": f"Iteration {iteration} backtest results sent."})
            conversation.append({"role": "assistant", "content": ai_analysis or "No analysis."})

            # 11. Update loop state
            prev_trade_count = trade_count
            prev_sharpe = sharpe
            current_ir = updated_ir

            # 12. Check target stopping conditions
            if target_sharpe is not None and sharpe >= target_sharpe:
                stop_reason = "target_sharpe"
                logger.info(
                    "Optimization run %s reached target Sharpe %.3f at iteration %d",
                    run_id, sharpe, iteration,
                )
                break

            if target_win_rate is not None and win_rate >= target_win_rate:
                stop_reason = "target_win_rate"
                logger.info(
                    "Optimization run %s reached target win rate %.3f at iteration %d",
                    run_id, win_rate, iteration,
                )
                break

        # ----------------------------------------------------------------
        # Save best strategy and complete the run
        # ----------------------------------------------------------------
        if best_backtest_id is not None:
            with data_db.get_sync_conn(settings.database_url) as conn:
                _complete_run(conn, run_id, stop_reason)

        _publish(r, run_id, "complete", {
            "run_id": run_id,
            "stop_reason": stop_reason,
            "best_iteration": best_iteration,
            "best_sharpe": best_sharpe,
            "best_win_rate": best_win_rate,
            "msg": f"Optimization complete ({stop_reason}). Best Sharpe: {best_sharpe:.3f}",
        })

        logger.info(
            "Optimization run %s finished: stop_reason=%s best_sharpe=%.3f",
            run_id, stop_reason, best_sharpe,
        )

        return {
            "status": "completed",
            "stop_reason": stop_reason,
            "best_iteration": best_iteration,
            "best_sharpe": best_sharpe,
        }

    except SoftTimeLimitExceeded:
        logger.warning("Optimization run %s hit soft time limit — saving best and exiting", run_id)
        with data_db.get_sync_conn(settings.database_url) as conn:
            _fail_run(conn, run_id, "time_limit_exceeded")
        _publish(r, run_id, "error", {"run_id": run_id, "msg": "Time limit exceeded"})
        return {"status": "failed", "reason": "time_limit_exceeded"}

    except Exception as exc:
        logger.exception("Optimization run %s failed: %s", run_id, exc)
        try:
            with data_db.get_sync_conn(settings.database_url) as conn:
                _fail_run(conn, run_id, str(exc))
            _publish(r, run_id, "error", {"run_id": run_id, "msg": str(exc)})
        except Exception:
            pass
        raise
