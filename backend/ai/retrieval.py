"""
Hybrid RAG retrieval — Phase 2 AI Co-Pilot.

Combines:
1. pgvector cosine similarity search (semantic)
2. PostgreSQL full-text search / BM25 (keyword)

Results from both are merged and deduplicated, then ranked by a simple
reciprocal rank fusion (RRF) score.  The top-N chunks are returned as
structured context dicts ready to be injected into the Claude system prompt.
"""

import logging
from typing import Any

import asyncpg

logger = logging.getLogger(__name__)

# Number of results from each retrieval method before fusion
_VECTOR_K = 5
_BM25_K = 5
# Final number of context chunks returned to the caller
_TOP_N = 6
# RRF smoothing constant
_RRF_K = 60


def _rrf_score(rank: int) -> float:
    return 1.0 / (_RRF_K + rank)


def _fuse(
    vector_rows: list[dict],
    bm25_rows: list[dict],
    id_key: str,
) -> list[dict]:
    """Merge two ranked lists using Reciprocal Rank Fusion."""
    scores: dict[str, float] = {}
    by_id: dict[str, dict] = {}

    for rank, row in enumerate(vector_rows, start=1):
        rid = str(row[id_key])
        scores[rid] = scores.get(rid, 0.0) + _rrf_score(rank)
        by_id[rid] = row

    for rank, row in enumerate(bm25_rows, start=1):
        rid = str(row[id_key])
        scores[rid] = scores.get(rid, 0.0) + _rrf_score(rank)
        by_id[rid] = row

    ranked = sorted(scores.keys(), key=lambda k: scores[k], reverse=True)
    return [by_id[rid] for rid in ranked[:_TOP_N]]


async def retrieve_context(
    query_embedding: list[float],
    query_text: str,
    conn: asyncpg.Connection,
    session_id: str | None = None,
) -> list[dict[str, Any]]:
    """
    Retrieve the most relevant context chunks for a given query.

    Returns a list of dicts, each with keys:
        source: "conversation" | "strategy" | "backtest"
        content: str   (the text to inject into the prompt)
        metadata: dict (id, pair, timeframe, etc.)
    """
    embedding_str = "[" + ",".join(str(x) for x in query_embedding) + "]"
    context: list[dict[str, Any]] = []

    # ------------------------------------------------------------------
    # 1. conversation_turns — past messages (excluding current session)
    # ------------------------------------------------------------------
    session_filter = "AND session_id != $3::uuid" if session_id else ""
    session_params: list[Any] = [embedding_str, query_text]
    if session_id:
        session_params.append(session_id)

    vector_turns = await conn.fetch(
        f"""
        SELECT id, session_id, role, content, strategy_id, created_at
        FROM conversation_turns
        WHERE embedding IS NOT NULL
        {session_filter}
        ORDER BY embedding <=> $1::vector
        LIMIT {_VECTOR_K}
        """,
        *session_params,
    )

    bm25_turns = await conn.fetch(
        f"""
        SELECT id, session_id, role, content, strategy_id, created_at
        FROM conversation_turns
        WHERE content_tsv @@ plainto_tsquery('english', $2)
        {session_filter}
        ORDER BY ts_rank(content_tsv, plainto_tsquery('english', $2)) DESC
        LIMIT {_BM25_K}
        """,
        *session_params,
    )

    fused_turns = _fuse(
        [dict(r) for r in vector_turns],
        [dict(r) for r in bm25_turns],
        id_key="id",
    )
    for row in fused_turns:
        context.append({
            "source": "conversation",
            "content": f"[{row['role'].upper()}] {row['content']}",
            "metadata": {
                "id": str(row["id"]),
                "session_id": str(row["session_id"]),
                "strategy_id": str(row["strategy_id"]) if row["strategy_id"] else None,
                "created_at": row["created_at"].isoformat(),
            },
        })

    # ------------------------------------------------------------------
    # 2. strategies — past strategy versions
    # ------------------------------------------------------------------
    vector_strategies = await conn.fetch(
        f"""
        SELECT id, version, description, pair, timeframe, ir_json
        FROM strategies
        WHERE embedding IS NOT NULL
        ORDER BY embedding <=> $1::vector
        LIMIT {_VECTOR_K}
        """,
        embedding_str,
    )

    bm25_strategies = await conn.fetch(
        f"""
        SELECT id, version, description, pair, timeframe, ir_json
        FROM strategies
        WHERE to_tsvector('english', description) @@ plainto_tsquery('english', $1)
        ORDER BY ts_rank(to_tsvector('english', description), plainto_tsquery('english', $1)) DESC
        LIMIT {_BM25_K}
        """,
        query_text,
    )

    fused_strategies = _fuse(
        [dict(r) for r in vector_strategies],
        [dict(r) for r in bm25_strategies],
        id_key="id",
    )
    for row in fused_strategies:
        context.append({
            "source": "strategy",
            "content": (
                f"[STRATEGY v{row['version']}] {row['pair']} {row['timeframe']}: "
                f"{row['description']}"
            ),
            "metadata": {
                "id": str(row["id"]),
                "version": row["version"],
                "pair": row["pair"],
                "timeframe": row["timeframe"],
                "ir_json": dict(row["ir_json"]),
            },
        })

    # ------------------------------------------------------------------
    # 3. backtest_runs — past results with AI summaries
    # ------------------------------------------------------------------
    vector_runs = await conn.fetch(
        f"""
        SELECT id, strategy_id, pair, timeframe, period_start, period_end,
               sharpe, sortino, max_dd, win_rate, trade_count, summary_text
        FROM backtest_runs
        WHERE embedding IS NOT NULL
        ORDER BY embedding <=> $1::vector
        LIMIT {_VECTOR_K}
        """,
        embedding_str,
    )

    bm25_runs = await conn.fetch(
        f"""
        SELECT id, strategy_id, pair, timeframe, period_start, period_end,
               sharpe, sortino, max_dd, win_rate, trade_count, summary_text
        FROM backtest_runs
        WHERE summary_tsv @@ plainto_tsquery('english', $1)
        ORDER BY ts_rank(summary_tsv, plainto_tsquery('english', $1)) DESC
        LIMIT {_BM25_K}
        """,
        query_text,
    )

    fused_runs = _fuse(
        [dict(r) for r in vector_runs],
        [dict(r) for r in bm25_runs],
        id_key="id",
    )
    for row in fused_runs:
        context.append({
            "source": "backtest",
            "content": (
                f"[BACKTEST] {row['pair']} {row['timeframe']} "
                f"{row['period_start']}→{row['period_end']}: "
                f"Sharpe={row['sharpe']}, MaxDD={row['max_dd']}, "
                f"WinRate={row['win_rate']}, Trades={row['trade_count']}. "
                f"{row['summary_text'] or ''}"
            ),
            "metadata": {
                "id": str(row["id"]),
                "strategy_id": str(row["strategy_id"]),
                "pair": row["pair"],
                "timeframe": row["timeframe"],
            },
        })

    return context
