from contextlib import asynccontextmanager
from typing import AsyncGenerator

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from prometheus_fastapi_instrumentator import Instrumentator

from routers import auth, backtest, health, strategy, trading, ws


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    # --- Startup ---
    # Database connection pool, Redis connection, etc. initialized here in later phases
    yield
    # --- Shutdown ---
    # Graceful cleanup of connections goes here


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
# Automatically instruments all routes with request count and latency.
# ---------------------------------------------------------------------------
Instrumentator().instrument(app).expose(app, endpoint="/metrics")

# ---------------------------------------------------------------------------
# Routers
# ---------------------------------------------------------------------------
app.include_router(health.router)
app.include_router(auth.router)
app.include_router(backtest.router)
app.include_router(strategy.router)
app.include_router(trading.router)
app.include_router(ws.router)
