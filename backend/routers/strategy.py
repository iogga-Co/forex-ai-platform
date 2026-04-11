"""
Strategy management endpoints.

Phase 1: POST /api/strategies — create a strategy with a raw SIR document.
         This is used for testing the backtest endpoint before the AI Co-Pilot
         (Phase 2) is built.

Phase 2: GET /api/strategies, GET /api/strategies/{id} — implemented with the
         AI Co-Pilot, including embeddings and RAG indexing.
"""

import logging
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from core.auth import TokenData, get_current_user
from core.db import get_pool
from engine.sir import StrategyIR

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/strategies", tags=["Strategy"])


class CreateStrategyRequest(BaseModel):
    ir_json: dict
    description: str
    pair: str
    timeframe: str


class StrategyResponse(BaseModel):
    id: UUID
    version: int
    description: str
    pair: str
    timeframe: str
    ir_json: dict


@router.post("", response_model=StrategyResponse, status_code=201)
async def create_strategy(
    payload: CreateStrategyRequest,
    _: Annotated[TokenData | None, Depends(get_current_user)] = None,
) -> StrategyResponse:
    """
    Save a new strategy version.

    In Phase 1 this is used directly (e.g. via curl/Swagger) to seed strategies
    for backtest testing.  In Phase 2 the AI Co-Pilot calls this automatically
    after the user approves a proposed SIR update.

    The IR is validated against the StrategyIR schema before insertion.
    """
    # Validate the SIR document before storing
    try:
        StrategyIR.model_validate(payload.ir_json)
    except Exception as exc:
        raise HTTPException(status_code=422, detail=f"Invalid Strategy IR: {exc}") from exc

    pair = payload.pair.upper().replace("/", "")
    pool = await get_pool()

    async with pool.acquire() as conn:
        # Determine the next version number for this pair/timeframe
        existing = await conn.fetchval(
            """
            SELECT COALESCE(MAX(version), 0)
            FROM strategies
            WHERE pair = $1 AND timeframe = $2
            """,
            pair,
            payload.timeframe,
        )
        version = existing + 1

        row = await conn.fetchrow(
            """
            INSERT INTO strategies (version, ir_json, description, pair, timeframe)
            VALUES ($1, $2, $3, $4, $5)
            RETURNING id, version, description, pair, timeframe, ir_json
            """,
            version,
            payload.ir_json,
            payload.description,
            pair,
            payload.timeframe,
        )

    logger.info("Created strategy %s v%d: %s %s", row["id"], version, pair, payload.timeframe)

    return StrategyResponse(
        id=row["id"],
        version=row["version"],
        description=row["description"],
        pair=row["pair"],
        timeframe=row["timeframe"],
        ir_json=dict(row["ir_json"]),
    )


@router.get("", response_model=list[StrategyResponse])
async def list_strategies(
    _: Annotated[TokenData | None, Depends(get_current_user)] = None,
) -> list[StrategyResponse]:
    """List all strategy versions, newest first."""
    pool = await get_pool()
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT id, version, description, pair, timeframe, ir_json
            FROM strategies
            ORDER BY created_at DESC
            LIMIT 100
            """
        )
    return [
        StrategyResponse(
            id=r["id"],
            version=r["version"],
            description=r["description"],
            pair=r["pair"],
            timeframe=r["timeframe"],
            ir_json=dict(r["ir_json"]),
        )
        for r in rows
    ]


@router.delete("/{strategy_id}", status_code=204)
async def delete_strategy(
    strategy_id: UUID,
    _: Annotated[TokenData | None, Depends(get_current_user)] = None,
) -> None:
    """Delete a strategy by ID."""
    pool = await get_pool()
    async with pool.acquire() as conn:
        result = await conn.execute(
            "DELETE FROM strategies WHERE id = $1",
            strategy_id,
        )

    if result == "DELETE 0":
        raise HTTPException(status_code=404, detail="Strategy not found")

    logger.info("Deleted strategy %s", strategy_id)


@router.get("/{strategy_id}", response_model=StrategyResponse)
async def get_strategy(
    strategy_id: UUID,
    _: Annotated[TokenData | None, Depends(get_current_user)] = None,
) -> StrategyResponse:
    """Retrieve a specific strategy version by ID."""
    pool = await get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            SELECT id, version, description, pair, timeframe, ir_json
            FROM strategies WHERE id = $1
            """,
            strategy_id,
        )

    if row is None:
        raise HTTPException(status_code=404, detail="Strategy not found")

    return StrategyResponse(
        id=row["id"],
        version=row["version"],
        description=row["description"],
        pair=row["pair"],
        timeframe=row["timeframe"],
        ir_json=dict(row["ir_json"]),
    )
