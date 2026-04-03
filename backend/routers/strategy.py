from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from core.auth import TokenData, get_current_user

router = APIRouter(prefix="/api/strategies", tags=["Strategy"])


class StrategyResponse(BaseModel):
    id: UUID
    version: int
    description: str
    pair: str
    timeframe: str
    ir_json: dict


@router.get("", response_model=list[StrategyResponse])
async def list_strategies(
    _: Annotated[TokenData, Depends(get_current_user)],
) -> list:
    """List all strategy versions. Implemented in Phase 2."""
    raise NotImplementedError("Strategy management implemented in Phase 2")


@router.get("/{strategy_id}", response_model=StrategyResponse)
async def get_strategy(
    strategy_id: UUID,
    _: Annotated[TokenData, Depends(get_current_user)],
) -> StrategyResponse:
    """Retrieve a specific strategy version. Implemented in Phase 2."""
    raise NotImplementedError("Strategy management implemented in Phase 2")


@router.post("", response_model=StrategyResponse, status_code=201)
async def create_strategy(
    payload: dict,
    _: Annotated[TokenData, Depends(get_current_user)],
) -> StrategyResponse:
    """
    Save a new strategy version (typically called by the AI Co-Pilot after
    the user approves a proposed SIR update). Implemented in Phase 2.
    """
    raise NotImplementedError("Strategy management implemented in Phase 2")
