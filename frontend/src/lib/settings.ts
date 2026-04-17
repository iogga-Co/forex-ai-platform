/**
 * Platform settings — stored in localStorage under "platform_settings".
 * All pages read from here and fall back to DEFAULTS if no value is set.
 */

export interface PlatformSettings {
  // Backtest
  backtest_history_limit: number;    // rows shown in history table (1–100)
  default_initial_capital: number;   // capital field prefill
  default_period_start: string;      // ISO date
  default_period_end: string;        // ISO date

  // Optimization
  default_max_iterations: number;    // max iterations prefill (1–100)
  default_time_limit_minutes: number; // time limit prefill (1–600)

  // Display / shared
  default_pair: string;
  default_timeframe: string;

  // AI model
  ai_model: string;
}

export const DEFAULTS: PlatformSettings = {
  backtest_history_limit: 20,
  default_initial_capital: 100_000,
  default_period_start: "2022-01-01",
  default_period_end: "2024-01-01",
  default_max_iterations: 20,
  default_time_limit_minutes: 60,
  default_pair: "EURUSD",
  default_timeframe: "1H",
  ai_model: "claude-sonnet-4-6",
};

const KEY = "platform_settings";

export function loadSettings(): PlatformSettings {
  if (typeof window === "undefined") return DEFAULTS;
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULTS;
    return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    return DEFAULTS;
  }
}

export function saveSettings(s: PlatformSettings): void {
  localStorage.setItem(KEY, JSON.stringify(s));
}
