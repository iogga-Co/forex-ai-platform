"""
Asyncpg connection pool — shared async DB client for the FastAPI process.

Celery workers and data pipeline scripts use psycopg2 (sync) via data/db.py.
This module is for FastAPI route handlers and WebSocket endpoints only.

Usage:
    # In main.py lifespan:
    await init_pool(settings.database_url)
    ...
    await close_pool()

    # As a FastAPI dependency:
    async def my_route(pool: asyncpg.Pool = Depends(get_pool)):
        async with pool.acquire() as conn:
            row = await conn.fetchrow("SELECT ...")
"""

import asyncpg

_pool: asyncpg.Pool | None = None


async def init_pool(dsn: str) -> None:
    """Create the module-level connection pool.  Called once at startup."""
    global _pool
    _pool = await asyncpg.create_pool(
        dsn=dsn,
        min_size=2,
        max_size=10,
        command_timeout=60,
    )


async def close_pool() -> None:
    """Drain and close the pool.  Called once at shutdown."""
    global _pool
    if _pool is not None:
        await _pool.close()
        _pool = None


async def get_pool() -> asyncpg.Pool:
    """Return the pool instance.  Raises if init_pool() was not called."""
    if _pool is None:
        raise RuntimeError("DB pool is not initialised — call init_pool() first")
    return _pool
