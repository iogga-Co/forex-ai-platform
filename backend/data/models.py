"""
Pydantic models for the data pipeline layer.

OHLCVBar is the canonical in-memory representation of a single candle.
All timestamps MUST be UTC-aware; the model_validator enforces this.
Prices are float (the DB stores NUMERIC, but Python always works in float64).
"""

from datetime import datetime, timezone

from pydantic import BaseModel, field_validator, model_validator


class OHLCVBar(BaseModel):
    pair: str          # e.g. "EURUSD"
    timeframe: str     # e.g. "1H", "1m", "1D"
    timestamp: datetime
    open: float
    high: float
    low: float
    close: float
    volume: float = 0.0

    @field_validator("pair")
    @classmethod
    def pair_uppercase(cls, v: str) -> str:
        return v.upper().replace("/", "").replace("-", "")

    @field_validator("timeframe")
    @classmethod
    def timeframe_normalise(cls, v: str) -> str:
        # Accept "1h" → "1H", "1m" → "1m" (minutes stay lowercase)
        # Convention: hours/days uppercase, minutes lowercase
        mapping = {"1h": "1H", "4h": "4H", "1d": "1D", "1w": "1W"}
        return mapping.get(v.lower(), v)

    @model_validator(mode="after")
    def timestamp_must_be_utc(self) -> "OHLCVBar":
        ts = self.timestamp
        if ts.tzinfo is None:
            raise ValueError(
                f"OHLCVBar timestamp must be UTC-aware, got naive datetime: {ts}. "
                "Use datetime(..., tzinfo=timezone.utc) or attach tz before constructing."
            )
        # Normalise to UTC (in case caller passed a non-UTC aware datetime)
        self.timestamp = ts.astimezone(timezone.utc)
        return self

    @model_validator(mode="after")
    def high_gte_low(self) -> "OHLCVBar":
        if self.high < self.low:
            raise ValueError(f"high ({self.high}) < low ({self.low})")
        return self


class IngestResult(BaseModel):
    pair: str
    timeframe: str
    rows_inserted: int
    rows_skipped: int      # ON CONFLICT DO NOTHING
    gaps_detected: int
    outliers_removed: int
