from fastapi import APIRouter
from pydantic import BaseModel

router = APIRouter()


class HealthResponse(BaseModel):
    status: str
    version: str


@router.get("/api/health", response_model=HealthResponse, tags=["Health"])
async def health_check() -> HealthResponse:
    """
    Health check endpoint — used by Docker, Nginx, and the CI smoke test.
    Returns 200 when the application is running.
    """
    return HealthResponse(status="ok", version="0.1.0")
