"""
TWAP (Time-Weighted Average Price) execution — Phase 5.3.

Splits a large order into `slices` equal parts and places them as separate
market orders with `interval_sec` between each slice.  The last slice absorbs
any integer-division remainder so the total always equals the intended size.

Used when a strategy's execution.mode is "twap".
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from live.oanda import OandaClient

logger = logging.getLogger(__name__)


async def execute_twap(
    oanda: OandaClient,
    instrument: str,
    total_units: int,
    slices: int,
    interval_sec: float,
) -> list[dict[str, Any]]:
    """
    Place total_units across `slices` market orders, waiting interval_sec between each.

    Parameters
    ----------
    oanda         : OandaClient instance
    instrument    : pair in internal format (e.g. "EURUSD")
    total_units   : signed total position size (positive = long, negative = short)
    slices        : number of sub-orders (≥ 2)
    interval_sec  : wait in seconds between consecutive slices

    Returns
    -------
    List of OANDA response dicts, one per attempted slice.
    Failed slices have an "error" key instead of order transaction data.
    Execution continues even if individual slices fail.
    """
    if slices < 2:
        raise ValueError(f"TWAP requires at least 2 slices, got {slices}")
    if total_units == 0:
        raise ValueError("TWAP total_units must be non-zero")

    sign      = 1 if total_units > 0 else -1
    abs_total = abs(total_units)
    base      = abs_total // slices
    remainder = abs_total - base * slices

    results: list[dict[str, Any]] = []

    for i in range(slices):
        # Last slice absorbs remainder so sum of slices == total_units
        slice_units = base + (remainder if i == slices - 1 else 0)
        if slice_units == 0:
            continue

        try:
            result = await oanda.place_market_order(
                instrument=instrument,
                units=sign * slice_units,
            )
            results.append(result)
            logger.info(
                "TWAP slice %d/%d: %s %+d units placed",
                i + 1, slices, instrument, sign * slice_units,
            )
        except Exception as exc:
            logger.error(
                "TWAP slice %d/%d failed for %s: %s",
                i + 1, slices, instrument, exc,
            )
            results.append({"error": str(exc)})

        if i < slices - 1:
            await asyncio.sleep(interval_sec)

    return results
