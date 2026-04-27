// ---------------------------------------------------------------------------
// Strategy IR — natural-language label helpers
// ---------------------------------------------------------------------------

export interface EntryCondition {
  indicator: string;
  period?: number;
  operator: string;
  value?: number | null;
  component?: string | null;
  fast?: number | null;
  slow?: number | null;
  signal_period?: number | null;
  std_dev?: number | null;
  k_smooth?: number | null;
  d_period?: number | null;
}

export interface ExitCondition {
  type: string;
  period?: number | null;
  multiplier?: number | null;
  pips?: number | null;
  percent?: number | null;
}

// ---------------------------------------------------------------------------
// conditionToLabel — entry condition → plain English sentence
// ---------------------------------------------------------------------------
function fv(v: number | null | undefined): string {
  if (v == null) return "";
  return String(parseFloat(v.toFixed(1)));
}

export function conditionToLabel(c: EntryCondition): string {
  const p = c.period;

  switch (c.indicator) {
    case "RSI": {
      const isAbove = c.operator === ">" || c.operator === ">=" || c.operator === "crossed_above";
      const dir = isAbove ? "above" : "below";
      const verb = c.operator === "crossed_above" ? "crosses above"
        : c.operator === "crossed_below" ? "crosses below" : null;
      const hint =
        c.value != null && c.value >= 70 ? "overbought"
        : c.value != null && c.value <= 30 ? "oversold"
        : c.value != null && c.value >= 50 && isAbove ? "momentum positive"
        : c.value != null && c.value < 50 && !isAbove ? "momentum negative"
        : "";
      if (verb) return `RSI (${p}) ${verb} ${fv(c.value)}${hint ? ` — ${hint}` : ""}`;
      return `RSI (${p}) ${dir} ${fv(c.value)}${hint ? ` — ${hint}` : ""}`;
    }

    case "EMA": {
      if (c.operator === "price_above") return `Price above EMA (${p})`;
      if (c.operator === "price_below") return `Price below EMA (${p})`;
      if (c.operator === "crossed_above" || c.operator === "cross_above")
        return `Price crosses above EMA (${p})`;
      if (c.operator === "crossed_below" || c.operator === "cross_below")
        return `Price crosses below EMA (${p})`;
      return `EMA (${p}) ${c.operator} ${fv(c.value)}`;
    }

    case "SMA": {
      if (c.operator === "price_above") return `Price above SMA (${p})`;
      if (c.operator === "price_below") return `Price below SMA (${p})`;
      if (c.operator === "crossed_above" || c.operator === "cross_above")
        return `Price crosses above SMA (${p})`;
      if (c.operator === "crossed_below" || c.operator === "cross_below")
        return `Price crosses below SMA (${p})`;
      return `SMA (${p}) ${c.operator} ${fv(c.value)}`;
    }

    case "MACD": {
      const params = `${c.fast}/${c.slow}/${c.signal_period}`;
      if (c.operator === "crossed_above" || c.operator === "cross_above")
        return `MACD crosses above signal (${params})`;
      if (c.operator === "crossed_below" || c.operator === "cross_below")
        return `MACD crosses below signal (${params})`;
      if (c.operator === ">") return `MACD line above signal (${params})`;
      if (c.operator === "<") return `MACD line below signal (${params})`;
      return `MACD (${params}) ${c.operator} ${fv(c.value)}`;
    }

    case "BB": {
      const comp = c.component ?? "middle";
      const band =
        comp === "upper" ? "upper"
        : comp === "lower" ? "lower"
        : "middle";
      const sigma = c.std_dev != null ? `${c.std_dev}σ` : "2σ";
      if (c.operator === "price_above") return `Price above ${band} Bollinger Band (${p}, ${sigma})`;
      if (c.operator === "price_below") return `Price below ${band} Bollinger Band (${p}, ${sigma})`;
      if (c.operator === "crossed_above" || c.operator === "cross_above")
        return `Price crosses above ${band} Bollinger Band (${p}, ${sigma})`;
      if (c.operator === "crossed_below" || c.operator === "cross_below")
        return `Price crosses below ${band} Bollinger Band (${p}, ${sigma})`;
      return `BB ${band} (${p}, ${sigma}) ${c.operator} ${fv(c.value)}`;
    }

    case "ATR": {
      const dir = c.operator === ">" || c.operator === ">=" ? "above" : "below";
      return `ATR (${p}) ${dir} ${fv(c.value)} — volatility ${dir === "above" ? "high" : "low"}`;
    }

    case "ADX": {
      const isAbove = c.operator === ">" || c.operator === ">=";
      const dir = isAbove ? "above" : "below";
      const hint =
        c.value != null && c.value >= 25 && isAbove ? "trend strong"
        : c.value != null && c.value < 25 && !isAbove ? "trend weak"
        : "";
      return `ADX (${p}) ${dir} ${fv(c.value)}${hint ? ` — ${hint}` : ""}`;
    }

    case "STOCH": {
      const isAbove = c.operator === ">" || c.operator === ">=";
      const dir = isAbove ? "above" : "below";
      const hint =
        c.value != null && c.value <= 20 && !isAbove ? "oversold"
        : c.value != null && c.value >= 80 && isAbove ? "overbought"
        : "";
      return `Stochastic K (${c.k_smooth ?? p}) ${dir} ${fv(c.value)}${hint ? ` — ${hint}` : ""}`;
    }

    default:
      return `${c.indicator} ${c.operator} ${fv(c.value)}`.trim();
  }
}

// ---------------------------------------------------------------------------
// exitConditionToLabel — SL/TP → plain English
// ---------------------------------------------------------------------------
export function exitConditionToLabel(
  label: "Stop Loss" | "Take Profit",
  ex: ExitCondition,
): string {
  if (ex.type === "atr")
    return `${label}: ATR (${ex.period}) × ${ex.multiplier?.toFixed(1)}`;
  if (ex.type === "fixed_pips")
    return `${label}: ${ex.pips} pips`;
  if (ex.type === "percent")
    return `${label}: ${((ex.percent ?? 0) * 100).toFixed(2)}%`;
  return `${label}: ${ex.type}`;
}

// ---------------------------------------------------------------------------
// filterToLabels — filters object → array of plain-English strings
// ---------------------------------------------------------------------------
export function filterToLabels(filters: {
  exclude_days?: string[];
  session?: string;
}): string[] {
  const labels: string[] = [];

  const sessionMap: Record<string, string> = {
    london_open:    "London session only",
    new_york_open:  "New York session only",
    asian_session:  "Asian session only",
    london:         "London session only",
    new_york:       "New York session only",
    asian:          "Asian session only",
  };

  if (filters.session && filters.session !== "all") {
    labels.push(sessionMap[filters.session] ?? `Session: ${filters.session}`);
  }

  if (filters.exclude_days && filters.exclude_days.length > 0) {
    const days = filters.exclude_days
      .map((d) => d.charAt(0).toUpperCase() + d.slice(1))
      .join(", ");
    labels.push(`Excludes ${days}`);
  }

  return labels;
}
