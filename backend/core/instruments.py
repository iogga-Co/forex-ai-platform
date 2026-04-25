_PIP_SIZES: dict[str, float] = {
    "EURUSD": 0.0001,
    "GBPUSD": 0.0001,
    "USDCHF": 0.0001,
    "EURGBP": 0.0001,
    "AUDUSD": 0.0001,
    "NZDUSD": 0.0001,
    "USDCAD": 0.0001,
    "USDJPY": 0.01,
    "GBPJPY": 0.01,
    "EURJPY": 0.01,
    "AUDJPY": 0.01,
    "CADJPY": 0.01,
    "CHFJPY": 0.01,
    "XAUUSD": 0.01,
    "XAGUSD": 0.001,
}


def get_pip_size(symbol: str) -> float:
    """Return pip size for a forex instrument symbol.

    Falls back to 0.0001 (standard 4-decimal pair) for unknown symbols.
    Normalises slashes so both 'EUR/USD' and 'EURUSD' work.
    """
    return _PIP_SIZES.get(symbol.replace("/", "").upper(), 0.0001)
