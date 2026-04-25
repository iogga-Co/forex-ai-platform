import { describe, it, expect } from "vitest";
import {
  conditionToLabel,
  exitConditionToLabel,
  filterToLabels,
} from "@/lib/strategyLabels";

// ---------------------------------------------------------------------------
// conditionToLabel
// ---------------------------------------------------------------------------
describe("conditionToLabel", () => {
  it("RSI above with overbought hint", () => {
    const label = conditionToLabel({ indicator: "RSI", period: 14, operator: ">", value: 70 });
    expect(label).toContain("RSI");
    expect(label).toContain("14");
    expect(label).toContain("above");
    expect(label).toContain("overbought");
  });

  it("RSI crossed_above", () => {
    const label = conditionToLabel({ indicator: "RSI", period: 14, operator: "crossed_above", value: 50 });
    expect(label).toContain("crosses above");
  });

  it("RSI below with oversold hint", () => {
    const label = conditionToLabel({ indicator: "RSI", period: 14, operator: "<", value: 30 });
    expect(label).toContain("below");
    expect(label).toContain("oversold");
  });

  it("EMA price_above", () => {
    expect(conditionToLabel({ indicator: "EMA", period: 20, operator: "price_above" }))
      .toBe("Price above EMA (20)");
  });

  it("EMA price_below", () => {
    expect(conditionToLabel({ indicator: "EMA", period: 50, operator: "price_below" }))
      .toBe("Price below EMA (50)");
  });

  it("SMA crossed_above", () => {
    const label = conditionToLabel({ indicator: "SMA", period: 200, operator: "crossed_above" });
    expect(label).toContain("crosses above SMA (200)");
  });

  it("MACD crossed_above signal — uses fast/slow/signal_period not period", () => {
    const label = conditionToLabel({
      indicator: "MACD", operator: "crossed_above",
      fast: 12, slow: 26, signal_period: 9,
    });
    expect(label).toContain("12/26/9");
    expect(label).toContain("crosses above");
  });

  it("MACD line above signal", () => {
    const label = conditionToLabel({
      indicator: "MACD", operator: ">",
      fast: 12, slow: 26, signal_period: 9,
    });
    expect(label).toContain("above signal");
  });

  it("BB upper band price_above — uses std_dev not period default", () => {
    const label = conditionToLabel({
      indicator: "BB", period: 20, operator: "price_above",
      component: "upper", std_dev: 2,
    });
    expect(label).toContain("upper");
    expect(label).toContain("2σ");
  });

  it("BB default std_dev shows 2σ", () => {
    const label = conditionToLabel({
      indicator: "BB", period: 20, operator: "price_below", component: "lower",
    });
    expect(label).toContain("2σ");
  });

  it("ATR above", () => {
    const label = conditionToLabel({ indicator: "ATR", period: 14, operator: ">", value: 0.001 });
    expect(label).toContain("ATR");
    expect(label).toContain("high");
  });

  it("ADX above with trend strong hint", () => {
    const label = conditionToLabel({ indicator: "ADX", period: 14, operator: ">", value: 25 });
    expect(label).toContain("trend strong");
  });

  it("STOCH oversold hint", () => {
    const label = conditionToLabel({
      indicator: "STOCH", operator: "<", value: 20, k_smooth: 5, d_period: 3,
    });
    expect(label).toContain("oversold");
  });

  it("unknown indicator falls back gracefully", () => {
    const label = conditionToLabel({ indicator: "UNKNOWN", operator: ">", value: 10 });
    expect(label).toContain("UNKNOWN");
  });
});

// ---------------------------------------------------------------------------
// exitConditionToLabel
// ---------------------------------------------------------------------------
describe("exitConditionToLabel", () => {
  it("ATR stop loss", () => {
    expect(exitConditionToLabel("Stop Loss", { type: "atr", period: 14, multiplier: 1.5 }))
      .toBe("Stop Loss: ATR (14) × 1.5");
  });

  it("ATR take profit", () => {
    expect(exitConditionToLabel("Take Profit", { type: "atr", period: 14, multiplier: 3 }))
      .toBe("Take Profit: ATR (14) × 3");
  });

  it("fixed_pips stop loss", () => {
    expect(exitConditionToLabel("Stop Loss", { type: "fixed_pips", pips: 20 }))
      .toBe("Stop Loss: 20 pips");
  });

  it("percent take profit", () => {
    const label = exitConditionToLabel("Take Profit", { type: "percent", percent: 0.02 });
    expect(label).toContain("2.00%");
  });

  it("unknown type falls back to type string", () => {
    const label = exitConditionToLabel("Stop Loss", { type: "custom_exit" });
    expect(label).toContain("custom_exit");
  });
});

// ---------------------------------------------------------------------------
// filterToLabels
// ---------------------------------------------------------------------------
describe("filterToLabels", () => {
  it("returns empty array for all-session no-exclude", () => {
    expect(filterToLabels({ session: "all" })).toEqual([]);
  });

  it("returns session label for london_open", () => {
    const labels = filterToLabels({ session: "london_open" });
    expect(labels).toHaveLength(1);
    expect(labels[0]).toContain("London");
  });

  it("returns excluded days label", () => {
    const labels = filterToLabels({ exclude_days: ["monday", "friday"] });
    expect(labels[0]).toContain("Monday");
    expect(labels[0]).toContain("Friday");
  });

  it("returns both session and days when both set", () => {
    const labels = filterToLabels({ session: "new_york_open", exclude_days: ["monday"] });
    expect(labels).toHaveLength(2);
  });

  it("unknown session falls back to raw value", () => {
    const labels = filterToLabels({ session: "tokyo_session" });
    expect(labels[0]).toContain("tokyo_session");
  });
});
