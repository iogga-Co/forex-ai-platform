// ---------------------------------------------------------------------------
// Strategy health badges — derived from backtest metrics
// ---------------------------------------------------------------------------

export type BadgeRating = "positive" | "neutral" | "negative";

export interface HealthBadge {
  label: string;
  value: string;
  rating: BadgeRating;
}

/**
 * Compute the four health badges from backtest metrics and trade-derived stats.
 *
 * profitFactor and avg duration values are computed from trades on the frontend
 * (not in the Metrics API response) — pass null to omit those badges.
 */
export function computeHealthBadges(
  metrics: {
    win_rate: number | null;
    max_dd: number | null;
  },
  profitFactor: number | null,
  avgWinDurationMin: number | null,
  avgLossDurationMin: number | null,
): HealthBadge[] {
  const badges: HealthBadge[] = [];

  // --- Consistency (win rate) ---
  if (metrics.win_rate !== null) {
    const wr = metrics.win_rate * 100;
    badges.push({
      label: "Consistency",
      value: wr >= 55 ? "High" : wr >= 45 ? "Medium" : "Low",
      rating: wr >= 55 ? "positive" : wr >= 45 ? "neutral" : "negative",
    });
  }

  // --- Risk Level (max drawdown) ---
  if (metrics.max_dd !== null) {
    const dd = Math.abs(metrics.max_dd) * 100;
    badges.push({
      label: "Risk Level",
      value: dd < 5 ? "Low" : dd <= 15 ? "Medium" : "High",
      rating: dd < 5 ? "positive" : dd <= 15 ? "neutral" : "negative",
    });
  }

  // --- Recovery Speed (avg loser duration / avg winner duration) ---
  if (avgWinDurationMin !== null && avgLossDurationMin !== null && avgWinDurationMin > 0) {
    const ratio = avgLossDurationMin / avgWinDurationMin;
    badges.push({
      label: "Recovery Speed",
      value: ratio < 1.5 ? "Fast" : ratio <= 3 ? "Moderate" : "Slow",
      rating: ratio < 1.5 ? "positive" : ratio <= 3 ? "neutral" : "negative",
    });
  }

  // --- Edge Quality (profit factor) ---
  if (profitFactor !== null) {
    badges.push({
      label: "Edge Quality",
      value: profitFactor > 1.8 ? "Strong" : profitFactor >= 1.2 ? "Moderate" : "Weak",
      rating: profitFactor > 1.8 ? "positive" : profitFactor >= 1.2 ? "neutral" : "negative",
    });
  }

  return badges;
}
