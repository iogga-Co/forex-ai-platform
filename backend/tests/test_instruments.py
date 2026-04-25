"""Unit tests for core/instruments.py."""

from core.instruments import get_pip_size


def test_standard_pairs_return_0001():
    for symbol in ["EURUSD", "GBPUSD", "USDCHF", "EURGBP", "AUDUSD"]:
        assert get_pip_size(symbol) == 0.0001, symbol


def test_jpy_pairs_return_001():
    for symbol in ["USDJPY", "GBPJPY", "EURJPY", "CADJPY"]:
        assert get_pip_size(symbol) == 0.01, symbol


def test_slash_notation_normalised():
    assert get_pip_size("EUR/USD") == 0.0001
    assert get_pip_size("USD/JPY") == 0.01


def test_case_insensitive():
    assert get_pip_size("eurusd") == 0.0001
    assert get_pip_size("usdjpy") == 0.01


def test_unknown_symbol_falls_back_to_0001():
    assert get_pip_size("USDMXN") == 0.0001
    assert get_pip_size("XYZABC") == 0.0001
