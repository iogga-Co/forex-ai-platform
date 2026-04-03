from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel

from core.auth import TokenData, get_current_user
from core.config import settings

router = APIRouter(prefix="/api/trading", tags=["Live Trading"])


class TradingStatusResponse(BaseModel):
    enabled: bool
    oanda_environment: str
    open_positions: int
    daily_pnl: float


@router.get("/status", response_model=TradingStatusResponse)
async def get_trading_status(
    _: Annotated[TokenData, Depends(get_current_user)],
) -> TradingStatusResponse:
    """Return current live trading engine state. Implemented in Phase 4."""
    return TradingStatusResponse(
        enabled=settings.live_trading_enabled,
        oanda_environment=settings.oanda_environment,
        open_positions=0,
        daily_pnl=0.0,
    )


@router.post("/enable", status_code=status.HTTP_204_NO_CONTENT)
async def enable_trading(
    _: Annotated[TokenData, Depends(get_current_user)],
) -> None:
    """
    Enable the live trading engine. Requires LIVE_TRADING_ENABLED=true in Doppler.
    This endpoint does NOT flip the flag — that is an explicit Doppler operator action.
    Implemented in Phase 4.
    """
    if not settings.live_trading_enabled:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Live trading is disabled. Set LIVE_TRADING_ENABLED=true in Doppler first.",
        )
    raise NotImplementedError("Live trading engine implemented in Phase 4")


@router.post("/kill-switch", status_code=status.HTTP_204_NO_CONTENT)
async def kill_switch(
    _: Annotated[TokenData, Depends(get_current_user)],
) -> None:
    """
    Emergency stop — closes all open positions immediately and disables the engine.
    Authenticated + rate-limited at Nginx (1 call / 10 seconds enforced in Phase 4).
    Implemented in Phase 4.
    """
    raise NotImplementedError("Kill switch implemented in Phase 4")
