// ---------------------------------------------------------------------------
// Strategy IR types + deep-merge patch helper
// ---------------------------------------------------------------------------

import type { EntryCondition, ExitCondition } from "./strategyLabels";

export interface StrategyIR {
  entry_conditions?: EntryCondition[];
  exit_conditions?: {
    stop_loss?:   ExitCondition;
    take_profit?: ExitCondition;
  };
  filters?: {
    exclude_days?: string[];
    session?: string;
  };
  position_sizing?: {
    risk_per_trade_pct?: number;
    max_size_units?: number;
  };
  metadata?: Record<string, unknown>;
}

/**
 * Merge a partial SIR patch onto a base SIR.
 *
 * Rules:
 * - entry_conditions: patch replaces base entirely (AI provides the full new array)
 * - exit_conditions:  deep merge — patch fields win, unpatch fields kept from base
 * - filters.exclude_days: union of base + patch arrays (no duplicates)
 * - filters.session: patch wins
 * - position_sizing: shallow merge, patch fields win
 * - metadata: shallow merge, patch fields win
 */
export function mergeIrPatch(
  base: StrategyIR,
  patch: Partial<StrategyIR>,
): StrategyIR {
  // Deep clone to avoid mutating the original
  const result: StrategyIR = JSON.parse(JSON.stringify(base));

  if (patch.entry_conditions !== undefined) {
    result.entry_conditions = patch.entry_conditions;
  }

  if (patch.exit_conditions !== undefined) {
    result.exit_conditions = {
      ...result.exit_conditions,
      ...patch.exit_conditions,
    };
  }

  if (patch.filters !== undefined) {
    const baseFilters = result.filters ?? {};
    const patchFilters = patch.filters;

    // Merge exclude_days as a union so applying "monday" to a base with
    // ["friday"] produces ["friday", "monday"], not a replacement.
    let mergedDays = baseFilters.exclude_days ?? [];
    if (patchFilters.exclude_days) {
      mergedDays = Array.from(
        new Set([...mergedDays, ...patchFilters.exclude_days])
      );
    }

    result.filters = {
      ...baseFilters,
      ...patchFilters,
      ...(mergedDays.length > 0 ? { exclude_days: mergedDays } : {}),
    };
  }

  if (patch.position_sizing !== undefined) {
    result.position_sizing = {
      ...result.position_sizing,
      ...patch.position_sizing,
    };
  }

  if (patch.metadata !== undefined) {
    result.metadata = {
      ...result.metadata,
      ...patch.metadata,
    };
  }

  return result;
}
