"""
Strategy Intermediate Representation (SIR) — Pydantic models.

The SIR is the canonical JSON format for all strategies.  It is human-readable,
versionable, and passed directly to the execution engine without LLM involvement
at runtime, ensuring full determinism and auditability.

Example SIR:
{
  "entry_conditions": [
    { "indicator": "RSI", "period": 14, "operator": ">", "value": 50 },
    { "indicator": "EMA", "period": 20, "operator": "price_above" }
  ],
  "exit_conditions": {
    "stop_loss":   { "type": "atr", "period": 14, "multiplier": 1.5 },
    "take_profit": { "type": "atr", "period": 14, "multiplier": 3.0 }
  },
  "filters": {
    "exclude_days": ["Monday"],
    "session": "london_open"
  },
  "position_sizing": {
    "risk_per_trade_pct": 2.0,
    "max_size_units": 100000
  }
}
"""

from typing import Literal

from pydantic import BaseModel, Field, model_validator


# ---------------------------------------------------------------------------
# Supported indicator names
# ---------------------------------------------------------------------------
IndicatorName = Literal["RSI", "EMA", "SMA", "MACD", "BB", "ATR", "ADX", "STOCH"]

# Operators that compare an indicator series to a numeric value
_THRESHOLD_OPERATORS = {">", "<", ">=", "<=", "==", "crossed_above", "crossed_below"}
# Operators that compare price to a price-level indicator (EMA, SMA, BB bands)
_PRICE_OPERATORS = {"price_above", "price_below"}
# Indicators that return a price-level series (not dimensionless)
_PRICE_LEVEL_INDICATORS = {"EMA", "SMA", "BB", "ATR"}
# Indicators that return a dimensionless series (0-100 or similar)
_DIMENSIONLESS_INDICATORS = {"RSI", "MACD", "ADX", "STOCH"}


class IndicatorCondition(BaseModel):
    indicator: IndicatorName
    period: int = Field(default=14, ge=1, le=500)
    operator: str

    # Comparison value — required for threshold operators, None for price operators
    value: float | None = None

    # Multi-output indicator component selectors
    # BB:   "upper" | "middle" | "lower"  (default: "middle")
    # MACD: "line"  | "signal" | "histogram" (default: "line")
    # STOCH: "k"   | "d"  (default: "k")
    component: str | None = None

    # MACD-specific periods (override the generic `period` field)
    fast: int | None = None
    slow: int | None = None
    signal_period: int | None = None

    # BB std multiplier (default 2.0)
    std_dev: float | None = None

    # Stochastic smoothing (k default 3, d default 3)
    k_smooth: int | None = None
    d_period: int | None = None

    @model_validator(mode="after")
    def validate_operator_value_pair(self) -> "IndicatorCondition":
        if self.operator in _THRESHOLD_OPERATORS and self.value is None:
            raise ValueError(
                f"operator '{self.operator}' requires a 'value' field "
                f"(e.g. {{\"operator\": \">\", \"value\": 50}})"
            )
        if self.operator in _PRICE_OPERATORS and self.value is not None:
            raise ValueError(
                f"operator '{self.operator}' does not use a 'value' field — "
                f"it compares price to the indicator series directly"
            )
        if self.operator in _PRICE_OPERATORS and self.indicator not in _PRICE_LEVEL_INDICATORS:
            raise ValueError(
                f"operator '{self.operator}' requires a price-level indicator "
                f"(EMA, SMA, BB, ATR), not '{self.indicator}'"
            )
        if self.operator not in _THRESHOLD_OPERATORS | _PRICE_OPERATORS:
            raise ValueError(
                f"Unknown operator '{self.operator}'.  "
                f"Supported: {sorted(_THRESHOLD_OPERATORS | _PRICE_OPERATORS)}"
            )
        return self


# Structurally identical to IndicatorCondition — alias for semantic clarity in exit context.
IndicatorExitCondition = IndicatorCondition


class StopConfig(BaseModel):
    type: Literal["atr", "fixed_pips", "percent"]
    period: int | None = None        # required when type="atr"
    multiplier: float | None = None  # required when type="atr"
    pips: float | None = None        # required when type="fixed_pips"
    percent: float | None = None     # required when type="percent" (0.01 = 1%)

    @model_validator(mode="after")
    def validate_fields_for_type(self) -> "StopConfig":
        if self.type == "atr":
            if self.period is None or self.multiplier is None:
                raise ValueError("ATR stop requires 'period' and 'multiplier'")
        elif self.type == "fixed_pips":
            if self.pips is None:
                raise ValueError("fixed_pips stop requires 'pips'")
        elif self.type == "percent":
            if self.percent is None:
                raise ValueError("percent stop requires 'percent'")
        return self


class TrailingStopConfig(BaseModel):
    enabled: bool = False
    type: Literal["atr", "fixed_pips"] = "atr"
    period: int | None = None
    multiplier: float | None = None   # ATR multiplier (trailing distance)
    pips: float | None = None         # fixed-pip trailing distance
    activation_multiplier: float = 1.0  # activate after this × ATR in profit from entry


class ExitConditions(BaseModel):
    stop_loss: StopConfig
    take_profit: StopConfig
    exit_mode: Literal["first", "all", "stops_only"] = "stops_only"
    indicator_exits: list[IndicatorExitCondition] = []
    trailing_stop: TrailingStopConfig | None = None


class FiltersConfig(BaseModel):
    exclude_days: list[
        Literal["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"]
    ] = []
    session: Literal[
        "london_open", "new_york_open", "asian_session", "all"
    ] = "all"


class PositionSizingConfig(BaseModel):
    risk_per_trade_pct: float = Field(default=1.0, gt=0, le=10)
    max_size_units: int = Field(default=100_000, gt=0)


class StrategyIR(BaseModel):
    entry_conditions: list[IndicatorCondition] = Field(min_length=1)
    exit_conditions: ExitConditions
    filters: FiltersConfig = Field(default_factory=FiltersConfig)
    position_sizing: PositionSizingConfig = Field(default_factory=PositionSizingConfig)
    metadata: dict = Field(default_factory=dict)
