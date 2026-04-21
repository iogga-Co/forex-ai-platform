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
from live.engine import run_engine
from live.feed import run_feed
from routers import analytics, auth, backtest, candles, copilot, diagnosis, g_optimize, health, lab, news, optimization, strategy, trading, ws
from routers import settings as settings_router

logger = logging.getLogger(__name__)

_redis_bridge_task: asyncio.Task | None = None
_redis_bridge_stop = asyncio.Event()
_feed_task:   asyncio.Task | None = None
_feed_stop:   asyncio.Event = asyncio.Event()
_engine_task: asyncio.Task | None = None
_engine_stop: asyncio.Event = asyncio.Event()


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    global _redis_bridge_task, _redis_bridge_stop, _feed_task, _feed_stop, _engine_task, _engine_stop

    # --- Startup ---
    logger.info("Initialising database connection pool")
    await core_db.init_pool(settings.database_url)

    logger.info("Starting Redis pub/sub bridge for WebSocket progress streaming")
    _redis_bridge_stop = asyncio.Event()
    _redis_bridge_task = asyncio.create_task(
        subscribe_and_forward(settings.redis_url, manager, _redis_bridge_stop),
        name="redis-bridge",
    )

    logger.info("Starting OANDA tick feed")
    _feed_stop = asyncio.Event()
    _feed_task = asyncio.create_task(run_feed(_feed_stop), name="oanda-feed")

    logger.info("Starting signal engine")
    _engine_stop = asyncio.Event()
    pool = await core_db.get_pool()
    _engine_task = asyncio.create_task(run_engine(_engine_stop, pool), name="signal-engine")

    yield

    # --- Shutdown ---
    logger.info("Stopping signal engine")
    _engine_stop.set()
    if _engine_task and not _engine_task.done():
        _engine_task.cancel()
        try:
            await _engine_task
        except asyncio.CancelledError:
            pass

    logger.info("Stopping OANDA tick feed")
    _feed_stop.set()
    if _feed_task and not _feed_task.done():
        _feed_task.cancel()
        try:
            await _feed_task
        except asyncio.CancelledError:
            pass

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
app.include_router(g_optimize.router)
app.include_router(lab.router)
app.include_router(diagnosis.router)
app.include_router(news.router)
app.include_router(settings_router.router)
app.include_router(ws.router)
