"""
Per-pair rolling spread tracker for live order gating (Phase 5.3).

Tracks the last N bid-ask spreads per pair and exposes the median in pips.
Used by the executor to skip signals when the spread is elevated (e.g. news,
rollover window, thin Asian-session liquidity).
"""

from __future__ import annotations

from collections import deque

from core.instruments import get_pip_size

_WINDOW = 20  # rolling window — last N ticks per pair


class SpreadTracker:
    """Rolling per-pair spread tracker."""

    def __init__(self, window: int = _WINDOW) -> None:
        self._window = window
        self._buf: dict[str, deque[float]] = {}

    def update(self, pair: str, bid: float, ask: float) -> None:
        """Record a new tick spread for `pair`."""
        spread = ask - bid
        if spread <= 0:
            return
        if pair not in self._buf:
            self._buf[pair] = deque(maxlen=self._window)
        self._buf[pair].append(spread)

    def current_pips(self, pair: str) -> float:
        """Median spread in pips. Returns 0.0 when no data has been recorded."""
        buf = self._buf.get(pair)
        if not buf:
            return 0.0
        pip = get_pip_size(pair)
        mid = len(buf) // 2
        return sorted(buf)[mid] / pip

    def is_acceptable(self, pair: str, max_pips: float) -> bool:
        """
        True when spread is within max_pips.
        Returns True on cold start (no data yet) to avoid blocking the first order.
        """
        pips = self.current_pips(pair)
        return pips == 0.0 or pips <= max_pips
