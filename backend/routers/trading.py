"""
Live Trading API endpoints — Phase 4 PR3.

GET  /api/trading/status      — engine + account summary
GET  /api/trading/positions   — open live_orders with unrealised P&L
GET  /api/trading/history     — closed live_orders (paginated)
POST /api/trading/kill-switch — close all positions + cancel all orders
"""

from __future__ import annotations

import json
import logging
import uuid
from typing import Annotated

import redis.asyncio as aioredis
from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel

from core.auth import TokenData, get_current_user, require_mfa
from core.config import settings
from core.db import get_pool
from live.executor import BALANCE_KEY, CMD_CHANNEL, CMD_RESULT_PREFIX

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/trading", tags=["Live Trading"])

CMD_TIMEOUT_S = 10.0  # seconds to wait for trading-service to respond


def _f(v: object) -> float | None:
    return float(v) if v is not None else None  # type: ignore[arg-type]


# ---------------------------------------------------------------------------
# GET /api/trading/status
# ---------------------------------------------------------------------------

class TradingStatusResponse(BaseModel):
    enabled:         bool
    oanda_environment: str
    open_positions:  int
    daily_pnl:       float
    account_balance: float | None
    shadow_mode:     bool


@router.get("/status", response_model=TradingStatusResponse)
async def get_trading_status(
    _: Annotated[TokenData, Depends(get_current_user)],
    pool=Depends(get_pool),
) -> TradingStatusResponse:
    open_positions = 0
    account_balance: float | None = None

    async with pool.acquire() as conn:
        open_positions = await conn.fetchval(
            "SELECT COUNT(*) FROM live_orders WHERE status = 'filled'"
        ) or 0

    # Balance is cached by the trading-service executor every poll cycle
    try:
        r = aioredis.from_url(settings.redis_url, decode_responses=True)
        raw = await r.get(BALANCE_KEY)
        await r.aclose()
        if raw is not None:
            account_balance = float(raw)
    except Exception as exc:
        logger.debug("Could not read cached account balance: %s", exc)

    return TradingStatusResponse(
        enabled=settings.live_trading_enabled,
        oanda_environment=settings.oanda_environment,
        open_positions=int(open_positions),
        daily_pnl=0.0,
        account_balance=account_balance,
        shadow_mode=not settings.live_trading_enabled,
    )


# ---------------------------------------------------------------------------
# GET /api/trading/positions
# ---------------------------------------------------------------------------

class PositionResponse(BaseModel):
    id:            str
    strategy_id:   str
    pair:          str | None
    direction:     str
    size:          float
    entry_price:   float | None
    opened_at:     str
    shadow_mode:   bool


@router.get("/positions", response_model=list[PositionResponse])
async def get_open_positions(
    _: Annotated[TokenData, Depends(get_current_user)],
    pool=Depends(get_pool),
) -> list[PositionResponse]:
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT lo.id, lo.strategy_id, s.pair, lo.direction,
                   lo.size, lo.entry_price, lo.opened_at, lo.shadow_mode
            FROM live_orders lo
            LEFT JOIN strategies s ON s.id = lo.strategy_id
            WHERE lo.status = 'filled'
            ORDER BY lo.opened_at DESC
            """
        )
    return [
        PositionResponse(
            id=str(r["id"]),
            strategy_id=str(r["strategy_id"]),
            pair=r["pair"],
            direction=r["direction"],
            size=float(r["size"]),
            entry_price=_f(r["entry_price"]),
            opened_at=r["opened_at"].isoformat(),
            shadow_mode=bool(r["shadow_mode"]),
        )
        for r in rows
    ]


# ---------------------------------------------------------------------------
# GET /api/trading/history
# ---------------------------------------------------------------------------

class OrderHistoryResponse(BaseModel):
    id:           str
    strategy_id:  str
    pair:         str | None
    direction:    str
    size:         float
    entry_price:  float | None
    exit_price:   float | None
    pnl:          float | None
    status:       str
    opened_at:    str
    closed_at:    str | None
    shadow_mode:  bool


@router.get("/history", response_model=list[OrderHistoryResponse])
async def get_order_history(
    _: Annotated[TokenData, Depends(get_current_user)],
    pool=Depends(get_pool),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
) -> list[OrderHistoryResponse]:
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT lo.id, lo.strategy_id, s.pair, lo.direction,
                   lo.size, lo.entry_price, lo.exit_price, lo.pnl,
                   lo.status, lo.opened_at, lo.closed_at, lo.shadow_mode
            FROM live_orders lo
            LEFT JOIN strategies s ON s.id = lo.strategy_id
            WHERE lo.status IN ('filled', 'closed', 'cancelled', 'rejected')
            ORDER BY lo.opened_at DESC
            LIMIT $1 OFFSET $2
            """,
            limit, offset,
        )
    return [
        OrderHistoryResponse(
            id=str(r["id"]),
            strategy_id=str(r["strategy_id"]),
            pair=r["pair"],
            direction=r["direction"],
            size=float(r["size"]),
            entry_price=_f(r["entry_price"]),
            exit_price=_f(r["exit_price"]),
            pnl=_f(r["pnl"]),
            status=r["status"],
            opened_at=r["opened_at"].isoformat(),
            closed_at=r["closed_at"].isoformat() if r["closed_at"] else None,
            shadow_mode=bool(r["shadow_mode"]),
        )
        for r in rows
    ]


# ---------------------------------------------------------------------------
# POST /api/trading/kill-switch
# ---------------------------------------------------------------------------

@router.post("/kill-switch", status_code=status.HTTP_200_OK)
async def kill_switch(
    _: Annotated[TokenData, Depends(get_current_user)],
    _mfa: Annotated[None, Depends(require_mfa)],
    pool=Depends(get_pool),
) -> dict:
    """
    Emergency stop — closes all open OANDA positions and marks all
    live_orders as cancelled.  Works in both live and shadow mode.

    In live mode, delegates to the trading-service via Redis live:commands.
    In shadow mode, cancels DB rows directly (no OANDA calls needed).
    """
    if not settings.live_trading_enabled:
        async with pool.acquire() as conn:
            await conn.execute(
                """
                UPDATE live_orders
                SET status = 'cancelled', closed_at = NOW()
                WHERE status IN ('pending', 'filled')
                """
            )
        return {"closed": 0, "message": "Shadow mode — DB orders cancelled"}

    # Delegate to trading-service via Redis command channel
    request_id = str(uuid.uuid4())
    result_key = CMD_RESULT_PREFIX + request_id
    try:
        r = aioredis.from_url(settings.redis_url, decode_responses=True)
        await r.publish(CMD_CHANNEL, json.dumps({"cmd": "kill_switch", "request_id": request_id}))
        raw = await r.blpop(result_key, timeout=int(CMD_TIMEOUT_S))
        await r.aclose()
    except Exception as exc:
        logger.error("Kill switch Redis error: %s", exc, exc_info=True)
        raise HTTPException(status_code=500, detail="Kill switch communication failed")

    if raw is None:
        raise HTTPException(
            status_code=504,
            detail="Trading service did not respond — kill switch timed out",
        )

    result = json.loads(raw[1])
    if not result.get("ok"):
        raise HTTPException(status_code=500, detail=result.get("error", "Kill switch failed"))

    closed = result.get("closed", 0)
    logger.info("Kill switch executed: %d positions closed", closed)
    return {"closed": closed, "message": f"Kill switch executed — {closed} position(s) closed"}


# ---------------------------------------------------------------------------
# POST /api/trading/enable (legacy stub — kept for backwards compat)
# ---------------------------------------------------------------------------

@router.post("/enable", status_code=status.HTTP_204_NO_CONTENT, response_model=None)
async def enable_trading(
    _: Annotated[TokenData, Depends(get_current_user)],
) -> None:
    if not settings.live_trading_enabled:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Live trading is disabled. Set LIVE_TRADING_ENABLED=true in Doppler first.",
        )
