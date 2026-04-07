"""
Voyage AI embedding client — Phase 2 AI Co-Pilot.

Wraps the Voyage AI API to produce 1024-dimensional embeddings.
Results are cached in Redis by SHA-256 hash of the input text to avoid
redundant API calls for repeated content.
"""

import hashlib
import json
import logging

import redis
import voyageai

from core.config import settings

logger = logging.getLogger(__name__)

_CACHE_TTL = 60 * 60 * 24 * 7  # 7 days
_CACHE_PREFIX = "emb:"
_VOYAGE_MODEL = "voyage-3"

_voyage_client: voyageai.AsyncClient | None = None
_redis_client: redis.Redis | None = None


def _get_voyage() -> voyageai.AsyncClient:
    global _voyage_client
    if _voyage_client is None:
        _voyage_client = voyageai.AsyncClient(api_key=settings.voyage_api_key)
    return _voyage_client


def _get_redis() -> redis.Redis:
    global _redis_client
    if _redis_client is None:
        _redis_client = redis.Redis.from_url(settings.redis_url, decode_responses=True)
    return _redis_client


def _cache_key(text: str) -> str:
    digest = hashlib.sha256(text.encode()).hexdigest()
    return f"{_CACHE_PREFIX}{digest}"


async def embed(text: str) -> list[float]:
    """
    Return a 1024-dimensional embedding for `text`.
    Checks Redis cache first; calls Voyage AI on cache miss.
    """
    r = _get_redis()
    key = _cache_key(text)

    cached = r.get(key)
    if cached:
        return json.loads(cached)

    client = _get_voyage()
    result = await client.embed([text], model=_VOYAGE_MODEL, input_type="document")
    vector = result.embeddings[0]

    try:
        r.setex(key, _CACHE_TTL, json.dumps(vector))
    except Exception as exc:
        logger.warning("Redis cache write failed: %s", exc)

    return vector


async def embed_query(text: str) -> list[float]:
    """
    Embed a search query (uses `input_type="query"` for better retrieval).
    Not cached — queries are typically unique.
    """
    client = _get_voyage()
    result = await client.embed([text], model=_VOYAGE_MODEL, input_type="query")
    return result.embeddings[0]


async def embed_batch(texts: list[str]) -> list[list[float]]:
    """
    Embed a batch of documents. Checks cache for each; fetches missing in one API call.
    """
    r = _get_redis()
    keys = [_cache_key(t) for t in texts]
    cached_values = r.mget(keys)

    missing_indices = [i for i, v in enumerate(cached_values) if v is None]
    results: list[list[float] | None] = [
        json.loads(v) if v else None for v in cached_values
    ]

    if missing_indices:
        missing_texts = [texts[i] for i in missing_indices]
        client = _get_voyage()
        api_result = await client.embed(
            missing_texts, model=_VOYAGE_MODEL, input_type="document"
        )
        for idx, vector in zip(missing_indices, api_result.embeddings):
            results[idx] = vector
            try:
                r.setex(keys[idx], _CACHE_TTL, json.dumps(vector))
            except Exception as exc:
                logger.warning("Redis cache write failed for index %d: %s", idx, exc)

    return results  # type: ignore[return-value]
