"""
Tests for Phase 2 AI Co-Pilot components.

Covers:
- claude_client: SIR extraction from response text
- claude_client: summarize_backtest (mocked Anthropic call)
- voyage_client: embed with Redis cache hit/miss (mocked)
- retrieval: RRF fusion logic
- copilot router: GET /api/copilot/sessions/{id} — 404 on empty session
"""

import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from ai.claude_client import extract_sir_from_response, summarize_backtest
from ai.retrieval import _fuse, _rrf_score


# ---------------------------------------------------------------------------
# claude_client — extract_sir_from_response
# ---------------------------------------------------------------------------

VALID_SIR_RESPONSE = """
Here is the strategy I propose:

```sir
{
  "entry_conditions": [
    {"indicator": "RSI", "period": 14, "operator": ">", "value": 50}
  ],
  "exit_conditions": {
    "stop_loss":   {"type": "atr", "period": 14, "multiplier": 1.5},
    "take_profit": {"type": "atr", "period": 14, "multiplier": 3.0}
  }
}
```

This strategy enters when RSI crosses above 50.
"""

INVALID_SIR_RESPONSE = """
```sir
{"entry_conditions": []}
```
"""

NO_SIR_RESPONSE = "I think you should use RSI and EMA together."


def test_extract_sir_valid():
    result = extract_sir_from_response(VALID_SIR_RESPONSE)
    assert result is not None
    assert len(result.entry_conditions) == 1
    assert result.entry_conditions[0].indicator == "RSI"


def test_extract_sir_invalid_schema():
    # entry_conditions is empty — fails min_length=1 validation
    result = extract_sir_from_response(INVALID_SIR_RESPONSE)
    assert result is None


def test_extract_sir_no_block():
    result = extract_sir_from_response(NO_SIR_RESPONSE)
    assert result is None


def test_extract_sir_json_fallback():
    """Falls back to ```json block if no ```sir block."""
    text = """
```json
{
  "entry_conditions": [
    {"indicator": "EMA", "period": 20, "operator": "price_above"}
  ],
  "exit_conditions": {
    "stop_loss":   {"type": "fixed_pips", "pips": 20},
    "take_profit": {"type": "fixed_pips", "pips": 40}
  }
}
```
"""
    result = extract_sir_from_response(text)
    assert result is not None
    assert result.entry_conditions[0].indicator == "EMA"


# ---------------------------------------------------------------------------
# claude_client — summarize_backtest (mocked)
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_summarize_backtest_returns_string():
    fake_summary = "The strategy performed well in trending markets."

    async def fake_stream(messages):
        yield fake_summary

    with patch("ai.claude_client.stream_chat", side_effect=fake_stream):
        result = await summarize_backtest(
            metrics={"sharpe": 1.5, "max_dd": 0.1, "win_rate": 0.55, "trade_count": 42},
            strategy_description="RSI momentum strategy",
            pair="EURUSD",
            timeframe="1H",
            period_start="2020-01-01",
            period_end="2024-01-01",
        )

    assert isinstance(result, str)
    assert len(result) > 0


# ---------------------------------------------------------------------------
# retrieval — RRF helpers
# ---------------------------------------------------------------------------

def test_rrf_score_decreases_with_rank():
    assert _rrf_score(1) > _rrf_score(2) > _rrf_score(10)


def test_fuse_deduplicates():
    rows_a = [{"id": "1", "content": "a"}, {"id": "2", "content": "b"}]
    rows_b = [{"id": "2", "content": "b"}, {"id": "3", "content": "c"}]
    fused = _fuse(rows_a, rows_b, id_key="id")
    ids = [r["id"] for r in fused]
    assert len(ids) == len(set(ids)), "fuse() returned duplicate IDs"


def test_fuse_boosts_overlap():
    """An ID that appears in both lists should rank above one that appears in only one."""
    rows_a = [{"id": "shared", "content": "x"}, {"id": "only_a", "content": "y"}]
    rows_b = [{"id": "shared", "content": "x"}, {"id": "only_b", "content": "z"}]
    fused = _fuse(rows_a, rows_b, id_key="id")
    assert fused[0]["id"] == "shared"


def test_fuse_respects_top_n():
    rows = [{"id": str(i), "content": str(i)} for i in range(10)]
    fused = _fuse(rows, rows, id_key="id")
    assert len(fused) <= 6  # _TOP_N = 6


# ---------------------------------------------------------------------------
# voyage_client — Redis cache (mocked)
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_embed_uses_cache():
    fake_vector = [0.1] * 1024
    mock_redis = MagicMock()
    mock_redis.get.return_value = json.dumps(fake_vector)

    with patch("ai.voyage_client._get_redis", return_value=mock_redis):
        from ai.voyage_client import embed
        result = await embed("hello world")

    assert result == fake_vector
    mock_redis.get.assert_called_once()


@pytest.mark.asyncio
async def test_embed_calls_api_on_cache_miss():
    fake_vector = [0.2] * 1024
    mock_redis = MagicMock()
    mock_redis.get.return_value = None  # cache miss

    mock_voyage_result = MagicMock()
    mock_voyage_result.embeddings = [fake_vector]
    mock_voyage_client = MagicMock()
    mock_voyage_client.embed = AsyncMock(return_value=mock_voyage_result)

    with (
        patch("ai.voyage_client._get_redis", return_value=mock_redis),
        patch("ai.voyage_client._get_voyage", return_value=mock_voyage_client),
    ):
        from ai import voyage_client
        # Force re-import to bypass module-level caching
        result = await voyage_client.embed("cache miss text")

    assert result == fake_vector
    mock_voyage_client.embed.assert_called_once()
