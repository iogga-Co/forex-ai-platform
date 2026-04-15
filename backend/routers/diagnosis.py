"""
Diagnosis endpoints.

POST /api/diagnosis/strategy — AI-powered strategy weakness analysis.
  Fetches backtest metrics + trades, pre-computes statistics, calls Claude,
  and returns up to 3 structured fix suggestions with ir_patch objects.
"""

import logging
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from ai.strategy_diagnosis import diagnose_strategy
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
