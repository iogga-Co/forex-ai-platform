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

import json

import asyncpg

_pool: asyncpg.Pool | None = None


async def _init_conn(conn: asyncpg.Connection) -> None:
    """Register JSON/JSONB codecs so columns decode to Python dicts automatically."""
    await conn.set_type_codec(
        "jsonb",
        encoder=json.dumps,
        decoder=json.loads,
        schema="pg_catalog",
    )
    await conn.set_type_codec(
        "json",
        encoder=json.dumps,
        decoder=json.loads,
        schema="pg_catalog",
    )


async def init_pool(dsn: str) -> None:
    """Create the module-level connection pool.  Called once at startup."""
    global _pool
    _pool = await asyncpg.create_pool(
        dsn=dsn,
        min_size=2,
        max_size=10,
        command_timeout=60,
        init=_init_conn,
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
