from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from core.auth import TokenData, get_current_user

router = APIRouter(prefix="/api/backtest", tags=["Backtest"])


class BacktestRequest(BaseModel):
    strategy_id: UUID
    period_start: str  # ISO date string e.g. "2020-01-01"
    period_end: str
    pair: str
    timeframe: str  # e.g. "1H", "1m"


class BacktestJobResponse(BaseModel):
    job_id: str
    status: str


class BacktestStatusResponse(BaseModel):
    job_id: str
    status: str          # "pending" | "running" | "complete" | "failed"
    progress_pct: int
    result_id: str | None = None


@router.post("", response_model=BacktestJobResponse)
async def run_backtest(
    payload: BacktestRequest,
    _: Annotated[TokenData, Depends(get_current_user)],
) -> BacktestJobResponse:
    """
    Dispatch a backtest job to Celery.
    Progress streams to the frontend via WebSocket (/ws/{session_id}).
    Implemented in Phase 1.
    """
    raise NotImplementedError("Backtest engine implemented in Phase 1")


@router.get("/{job_id}/status", response_model=BacktestStatusResponse)
async def get_backtest_status(
    job_id: str,
    _: Annotated[TokenData, Depends(get_current_user)],
) -> BacktestStatusResponse:
    """Poll backtest job status. Implemented in Phase 1."""
    raise NotImplementedError("Backtest engine implemented in Phase 1")


@router.get("/{result_id}")
async def get_backtest_result(
    result_id: UUID,
    _: Annotated[TokenData, Depends(get_current_user)],
) -> dict:
    """Retrieve a completed backtest result. Implemented in Phase 1."""
    raise NotImplementedError("Backtest engine implemented in Phase 1")
