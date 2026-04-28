"""
Tests for Phase 5.4 — RAG Evaluation.

Covers:
- _fuse includes rrf_score in returned items
- _fuse threshold filtering
- GET /api/rag/coverage endpoint
- POST /api/rag/backfill endpoint
"""

import uuid
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi.testclient import TestClient

from ai.retrieval import _fuse, _MIN_RRF_SCORE, _RRF_K


# ---------------------------------------------------------------------------
# _fuse unit tests
# ---------------------------------------------------------------------------

def _make_row(id_: int, extra: dict | None = None) -> dict:
    row = {"id": id_}
    if extra:
        row.update(extra)
    return row


def test_fuse_includes_rrf_score():
    vec = [_make_row(1), _make_row(2)]
    bm25 = [_make_row(1), _make_row(3)]
    result = _fuse(vec, bm25, id_key="id")
    ids = [r["id"] for r in result]
    # item 1 appears in both lists — must be first
    assert ids[0] == 1
    # every item has _rrf
    for item in result:
        assert "_rrf" in item
        assert item["_rrf"] > 0


def test_fuse_dual_path_scores_higher():
    # item 1 in both lists, item 2 only in vector list
    vec = [_make_row(1), _make_row(2)]
    bm25 = [_make_row(1)]
    result = _fuse(vec, bm25, id_key="id")
    by_id = {r["id"]: r for r in result}
    assert by_id[1]["_rrf"] > by_id[2]["_rrf"]


def test_fuse_filters_below_threshold():
    # Single-path hit at rank 5 — score = 1/(60+5) ≈ 0.0154, just above 0.015
    # Single-path hit at rank 5 should survive; rank 61 would score 1/121 ≈ 0.0083
    vec = [_make_row(i) for i in range(1, 62)]  # 61 items
    result = _fuse(vec, [], id_key="id")
    # Item at rank 61 scores 1/(60+61)=1/121≈0.0083, below _MIN_RRF_SCORE=0.015
    ids = {r["id"] for r in result}
    assert 61 not in ids


def test_fuse_empty_inputs():
    assert _fuse([], [], id_key="id") == []


def test_fuse_deduplicates():
    vec = [_make_row(1), _make_row(1)]  # duplicate
    bm25 = [_make_row(1)]
    result = _fuse(vec, bm25, id_key="id")
    assert len([r for r in result if r["id"] == 1]) == 1


# ---------------------------------------------------------------------------
# GET /api/rag/coverage
# ---------------------------------------------------------------------------

def _make_pool_mock(strat_total=10, strat_emb=8, runs_total=50, runs_emb=40,
                    turns_total=200, turns_emb=195, recent=12):
    def _row(data: dict):
        r = MagicMock()
        r.__getitem__ = lambda self, k: data[k]
        return r

    conn = AsyncMock()
    conn.fetchrow = AsyncMock(side_effect=[
        _row({"total": strat_total, "embedded": strat_emb}),
        _row({"total": runs_total, "embedded": runs_emb}),
        _row({"total": turns_total, "embedded": turns_emb}),
    ])
    conn.fetchval = AsyncMock(return_value=recent)
    conn.__aenter__ = AsyncMock(return_value=conn)
    conn.__aexit__ = AsyncMock(return_value=False)

    pool = AsyncMock()
    pool.acquire = MagicMock(return_value=conn)
    return pool


def test_coverage_endpoint():
    from main import app
    from core.auth import get_current_user

    pool = _make_pool_mock()
    app.dependency_overrides[get_current_user] = lambda: MagicMock()

    with patch("routers.rag.get_pool", AsyncMock(return_value=pool)):
        client = TestClient(app, raise_server_exceptions=True)
        resp = client.get("/api/rag/coverage")

    app.dependency_overrides.clear()

    assert resp.status_code == 200
    body = resp.json()
    assert body["strategies"]["total"] == 10
    assert body["strategies"]["embedded"] == 8
    assert body["backtest_runs"]["total"] == 50
    assert body["backtest_runs"]["embedded"] == 40
    assert body["conversation_turns"]["total"] == 200
    assert body["recent_retrievals_24h"] == 12


# ---------------------------------------------------------------------------
# POST /api/rag/backfill
# ---------------------------------------------------------------------------

def test_backfill_enqueues_task():
    from main import app
    from core.auth import get_current_user

    fake_task = MagicMock()
    fake_task.id = str(uuid.uuid4())

    app.dependency_overrides[get_current_user] = lambda: MagicMock()

    # backfill_embeddings is imported lazily inside trigger_backfill — patch at module level
    with patch("tasks.rag_backfill.backfill_embeddings") as mock_fn:
        mock_fn.delay.return_value = fake_task
        # also intercept the lazy import so the router picks up the mock
        with patch.dict("sys.modules", {"tasks.rag_backfill": MagicMock(backfill_embeddings=mock_fn)}):
            client = TestClient(app, raise_server_exceptions=True)
            resp = client.post("/api/rag/backfill")

    app.dependency_overrides.clear()

    assert resp.status_code == 202
    assert "job_id" in resp.json()
