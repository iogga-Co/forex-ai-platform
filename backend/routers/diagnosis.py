"""
Diagnosis endpoints.

POST /api/diagnosis/strategy         — AI-powered strategy weakness analysis.
POST /api/diagnosis/trades/stats     — pre-compute selection vs population stats (no AI).
POST /api/diagnosis/trades/analyze   — AI pattern analysis of a selected trade subset.
"""

import logging
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from ai.strategy_diagnosis import diagnose_strategy
from ai.trade_analysis import analyze_trades
from core.auth import TokenData, get_current_user
from core.db import get_pool

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/diagnosis", tags=["Diagnosis"])


def _f(v: object) -> float | None:
    """Cast asyncpg Decimal/NUMERIC to float."""
    return float(v) if v is not None else None  # type: ignore[arg-type]


# ---------------------------------------------------------------------------
# Request model
# ---------------------------------------------------------------------------

class DiagnoseStrategyRequest(BaseModel):
    backtest_run_id: UUID


# ---------------------------------------------------------------------------
# POST /api/diagnosis/strategy
# ---------------------------------------------------------------------------

@router.post("/strategy")
async def diagnose_strategy_endpoint(
    payload: DiagnoseStrategyRequest,
    _: Annotated[TokenData | None, Depends(get_current_user)] = None,
) -> dict:
    pool = await get_pool()
    async with pool.acquire() as conn:

        # Fetch run metrics + strategy name in one query
        run = await conn.fetchrow(
            """
            SELECT br.pair, br.timeframe, br.strategy_id,
                   br.sharpe, br.max_dd, br.win_rate, br.trade_count,
                   s.description
            FROM   backtest_results br
            JOIN   strategies s ON s.id = br.strategy_id
            WHERE  br.id = $1
            """,
            payload.backtest_run_id,
        )
        if not run:
            raise HTTPException(status_code=404, detail="Backtest result not found")

        # Fetch all trades for the run
        trades = await conn.fetch(
            """
            SELECT direction, pnl, r_multiple, mae, mfe, entry_time, exit_time
            FROM   trades
            WHERE  backtest_run_id = $1
            ORDER  BY entry_time
            """,
            payload.backtest_run_id,
        )

    # Pre-compute stats (no AI)
    stats = _compute_stats(trades)

    metrics = {
        "sharpe":      _f(run["sharpe"]),
        "max_dd":      _f(run["max_dd"]),
        "win_rate":    _f(run["win_rate"]),
        "trade_count": run["trade_count"],
    }

    result = await diagnose_strategy(
        strategy_name=run["description"] or "Unnamed Strategy",
        pair=run["pair"],
        timeframe=run["timeframe"],
        metrics=metrics,
        trade_stats=stats,
    )
    return result


# ---------------------------------------------------------------------------
# Stats pre-computation (pure Python, no AI)
# ---------------------------------------------------------------------------

def _compute_stats(trades) -> dict:
    if not trades:
        return {}

    winners = [t for t in trades if t["pnl"] is not None and float(t["pnl"]) > 0]
    losers  = [t for t in trades if t["pnl"] is not None and float(t["pnl"]) <= 0]

    gross_profit = sum(float(t["pnl"]) for t in winners)
    gross_loss   = abs(sum(float(t["pnl"]) for t in losers))
    profit_factor = round(gross_profit / gross_loss, 3) if gross_loss > 0 else None

    # Stop-out rate: losing trades where MFE never went positive
    # (price never moved in our favour before hitting the stop)
    stop_outs = [
        t for t in losers
        if t["mfe"] is not None and float(t["mfe"]) <= 0
    ]
    stop_out_rate = round(len(stop_outs) / len(trades) * 100, 1) if trades else 0

    # Direction breakdown
    longs  = [t for t in trades if t["direction"] == "long"]
    shorts = [t for t in trades if t["direction"] == "short"]
    long_wins  = [t for t in longs  if t["pnl"] is not None and float(t["pnl"]) > 0]
    short_wins = [t for t in shorts if t["pnl"] is not None and float(t["pnl"]) > 0]

    # Day-of-week breakdown (UTC)
    by_dow: dict[str, dict] = {}
    for t in trades:
        day = t["entry_time"].strftime("%A").lower()
        if day not in by_dow:
            by_dow[day] = {"count": 0, "wins": 0}
        by_dow[day]["count"] += 1
        if t["pnl"] is not None and float(t["pnl"]) > 0:
            by_dow[day]["wins"] += 1
    for v in by_dow.values():
        v["win_rate"] = round(v["wins"] / v["count"], 3) if v["count"] > 0 else 0

    # Hour-of-day breakdown (UTC)
    by_hour: dict[str, dict] = {}
    for t in trades:
        h = str(t["entry_time"].hour)
        if h not in by_hour:
            by_hour[h] = {"count": 0, "wins": 0}
        by_hour[h]["count"] += 1
        if t["pnl"] is not None and float(t["pnl"]) > 0:
            by_hour[h]["wins"] += 1
    for v in by_hour.values():
        v["win_rate"] = round(v["wins"] / v["count"], 3) if v["count"] > 0 else 0

    # Avg R-multiple by outcome
    def avg_r(trade_list):
        rs = [float(t["r_multiple"]) for t in trade_list if t["r_multiple"] is not None]
        return round(sum(rs) / len(rs), 3) if rs else None

    return {
        "profit_factor":     profit_factor,
        "stop_out_rate_pct": stop_out_rate,
        "long_count":        len(longs),
        "short_count":       len(shorts),
        "long_win_rate":     round(len(long_wins)  / len(longs),  3) if longs  else 0,
        "short_win_rate":    round(len(short_wins) / len(shorts), 3) if shorts else 0,
        "avg_win_r":         avg_r(winners),
        "avg_loss_r":        avg_r(losers),
        "by_dow":            by_dow,
        "by_hour":           by_hour,
    }


# ---------------------------------------------------------------------------
# Request models for trade analysis endpoints
# ---------------------------------------------------------------------------

class TradeStatsRequest(BaseModel):
    backtest_run_id: UUID
    trade_ids: list[UUID]


class TradeAnalyzeRequest(BaseModel):
    backtest_run_id: UUID
    trade_ids: list[UUID]
    stats: dict


# ---------------------------------------------------------------------------
# POST /api/diagnosis/trades/stats
# ---------------------------------------------------------------------------

@router.post("/trades/stats")
async def trade_stats_endpoint(
    payload: TradeStatsRequest,
    _: Annotated[TokenData | None, Depends(get_current_user)] = None,
) -> dict:
    """Pre-compute selection vs population stats — no AI."""
    if len(payload.trade_ids) < 2:
        raise HTTPException(status_code=400, detail="At least 2 trade_ids required")

    pool = await get_pool()
    async with pool.acquire() as conn:
        # Fetch backtest run for strategy name
        run = await conn.fetchrow(
            """
            SELECT br.pair, br.timeframe, s.description
            FROM   backtest_results br
            JOIN   strategies s ON s.id = br.strategy_id
            WHERE  br.id = $1
            """,
            payload.backtest_run_id,
        )
        if not run:
            raise HTTPException(status_code=404, detail="Backtest result not found")

        # All trades for this run (population)
        all_trades = await conn.fetch(
            """
            SELECT id, direction, pnl, r_multiple, mae, mfe, entry_time, exit_time
            FROM   trades
            WHERE  backtest_run_id = $1
            """,
            payload.backtest_run_id,
        )

        # Selected trades
        trade_id_strs = [str(tid) for tid in payload.trade_ids]
        selected_trades = [t for t in all_trades if str(t["id"]) in trade_id_strs]

    if not selected_trades:
        raise HTTPException(status_code=404, detail="None of the requested trade IDs found")

    def _dur_min(t) -> float:
        return (t["exit_time"] - t["entry_time"]).total_seconds() / 60

    def _stats_for(trades) -> dict:
        if not trades:
            return {}
        pnls      = [float(t["pnl"]) for t in trades if t["pnl"] is not None]
        rs        = [float(t["r_multiple"]) for t in trades if t["r_multiple"] is not None]
        maes      = [float(t["mae"]) for t in trades if t["mae"] is not None]
        mfes      = [float(t["mfe"]) for t in trades if t["mfe"] is not None]
        durations = [_dur_min(t) for t in trades]
        winners   = [p for p in pnls if p > 0]
        losers    = [p for p in pnls if p <= 0]
        longs     = [t for t in trades if t["direction"] == "long"]
        shorts    = [t for t in trades if t["direction"] == "short"]
        long_wins  = [t for t in longs  if t["pnl"] is not None and float(t["pnl"]) > 0]
        short_wins = [t for t in shorts if t["pnl"] is not None and float(t["pnl"]) > 0]

        by_hour: dict[str, dict] = {}
        by_dow:  dict[str, dict] = {}
        for t in trades:
            h   = str(t["entry_time"].hour)
            day = t["entry_time"].strftime("%A").lower()
            for bucket, key in [(by_hour, h), (by_dow, day)]:
                if key not in bucket:
                    bucket[key] = {"count": 0, "wins": 0}
                bucket[key]["count"] += 1
                if t["pnl"] is not None and float(t["pnl"]) > 0:
                    bucket[key]["wins"] += 1
        for v in list(by_hour.values()) + list(by_dow.values()):
            v["win_rate"] = round(v["wins"] / v["count"], 3) if v["count"] else 0

        return {
            "count":            len(trades),
            "win_rate":         round(len(winners) / len(pnls), 3) if pnls else 0,
            "avg_pnl":          round(sum(pnls) / len(pnls), 2) if pnls else 0,
            "avg_loss":         round(sum(losers) / len(losers), 2) if losers else 0,
            "avg_r":            round(sum(rs) / len(rs), 3) if rs else 0,
            "avg_duration_min": round(sum(durations) / len(durations), 1) if durations else 0,
            "avg_mae":          round(sum(maes) / len(maes), 5) if maes else 0,
            "avg_mfe":          round(sum(mfes) / len(mfes), 5) if mfes else 0,
            "long_count":       len(longs),
            "short_count":      len(shorts),
            "long_win_rate":    round(len(long_wins)  / len(longs),  3) if longs  else None,
            "short_win_rate":   round(len(short_wins) / len(shorts), 3) if shorts else None,
            "by_hour":          by_hour,
            "by_dow":           by_dow,
        }

    return {
        "strategy_name": run["description"] or "Unnamed Strategy",
        "pair":          run["pair"],
        "timeframe":     run["timeframe"],
        "selection":     _stats_for(selected_trades),
        "population":    _stats_for(list(all_trades)),
    }


# ---------------------------------------------------------------------------
# POST /api/diagnosis/trades/analyze
# ---------------------------------------------------------------------------

@router.post("/trades/analyze")
async def trade_analyze_endpoint(
    payload: TradeAnalyzeRequest,
    _: Annotated[TokenData | None, Depends(get_current_user)] = None,
) -> dict:
    """AI pattern analysis using pre-computed stats from /trades/stats."""
    if len(payload.trade_ids) < 2:
        raise HTTPException(status_code=400, detail="At least 2 trade_ids required")

    pool = await get_pool()
    async with pool.acquire() as conn:
        run = await conn.fetchrow(
            """
            SELECT br.pair, br.timeframe, s.description
            FROM   backtest_results br
            JOIN   strategies s ON s.id = br.strategy_id
            WHERE  br.id = $1
            """,
            payload.backtest_run_id,
        )
    if not run:
        raise HTTPException(status_code=404, detail="Backtest result not found")

    return await analyze_trades(
        strategy_name=run["description"] or "Unnamed Strategy",
        pair=run["pair"],
        timeframe=run["timeframe"],
        stats=payload.stats,
    )
