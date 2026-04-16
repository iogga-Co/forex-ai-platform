import asyncio
import logging
from contextlib import asynccontextmanager
from typing import AsyncGenerator

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from prometheus_fastapi_instrumentator import Instrumentator

from core import db as core_db
from core.config import settings
from core.redis_bridge import subscribe_and_forward
from core.websocket import manager
from routers import analytics, auth, backtest, candles, copilot, diagnosis, health, news, optimization, strategy, trading, ws

logger = logging.getLogger(__name__)

_redis_bridge_task: asyncio.Task | None = None
_redis_bridge_stop = asyncio.Event()


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    global _redis_bridge_task, _redis_bridge_stop

    # --- Startup ---
    logger.info("Initialising database connection pool")
    await core_db.init_pool(settings.database_url)

    logger.info("Starting Redis pub/sub bridge for WebSocket progress streaming")
    _redis_bridge_stop = asyncio.Event()
    _redis_bridge_task = asyncio.create_task(
        subscribe_and_forward(settings.redis_url, manager, _redis_bridge_stop),
        name="redis-bridge",
    )

    yield

    # --- Shutdown ---
    logger.info("Shutting down Redis bridge")
    _redis_bridge_stop.set()
    if _redis_bridge_task and not _redis_bridge_task.done():
        _redis_bridge_task.cancel()
        try:
            await _redis_bridge_task
        except asyncio.CancelledError:
            pass

    logger.info("Closing database connection pool")
    await core_db.close_pool()


app = FastAPI(
    title="Forex AI Trading Platform",
    version="0.1.0",
    docs_url="/api/docs",
    redoc_url="/api/redoc",
    openapi_url="/api/openapi.json",
    lifespan=lifespan,
)

# ---------------------------------------------------------------------------
# CORS — Next.js frontend is served from the same domain via Nginx,
# so only localhost origins are needed for local dev.
# ---------------------------------------------------------------------------
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ---------------------------------------------------------------------------
# Prometheus metrics — exposes /metrics for Prometheus scraping.
# ---------------------------------------------------------------------------
Instrumentator().instrument(app).expose(app, endpoint="/metrics")

# ---------------------------------------------------------------------------
# Routers
# ---------------------------------------------------------------------------
app.include_router(health.router)
app.include_router(auth.router)
app.include_router(backtest.router)
app.include_router(candles.router)
app.include_router(analytics.router)
app.include_router(strategy.router)
app.include_router(copilot.router)
app.include_router(trading.router)
app.include_router(optimization.router)
app.include_router(diagnosis.router)
app.include_router(news.router)
app.include_router(ws.router)
