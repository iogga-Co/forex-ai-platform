"use client";

import { useState } from "react";
import Link from "next/link";
import { fetchWithAuth } from "@/lib/auth";
import { loadSettings } from "@/lib/settings";
import type { GOptimizeRun } from "@/lib/gOptimizeTypes";

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
type Scope = "checked" | "run" | "all";

interface Recommendation {
  rank:                  number;
  backtest_run_id:       string;
  summary:               string;
  rationale:             string;
  suggested_refinement:  string;
}

interface AnalysisResult {
  recommendations: Recommendation[];
  skipped:         string[];
  skipped_reason:  string;
  strategy_ids?:   Record<string, string | null>;
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------
interface Props {
  checkedStrategyIds: Set<string>;
  checkedRunIds:      Set<string>;
  targetRunIds:       string[];       // selected or checked run IDs for "run" scope
  runs:               GOptimizeRun[]; // reserved for future run-name display
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------
export default function GOptimizeCopilotPanel({
  checkedStrategyIds, checkedRunIds, targetRunIds,
}: Props) {
  const [scope,   setScope]   = useState<Scope>("checked");
  const [loading, setLoading] = useState(false);
  const [result,  setResult]  = useState<AnalysisResult | null>(null);
  const [error,   setError]   = useState<string | null>(null);

  // -------------------------------------------------------------------------
  // Derived state
  // -------------------------------------------------------------------------
  const scopeRunIds  = checkedRunIds.size > 0 ? Array.from(checkedRunIds) : targetRunIds;
  const nRuns        = scopeRunIds.length;
  const nStrategies  = checkedStrategyIds.size;

  const canSend =
    scope === "all" ||
    (scope === "run"  && nRuns > 0) ||
    (scope === "checked" && nStrategies > 0);

  function summaryLabel(): string {
    if (scope === "all")     return "All passed strategies from all runs";
    if (scope === "run")     return `${nRuns} run${nRuns !== 1 ? "s" : ""} — all passed strategies`;
    return `${nStrategies} selected strateg${nStrategies !== 1 ? "ies" : "y"}`;
  }

  // -------------------------------------------------------------------------
  // Analysis
  // -------------------------------------------------------------------------
  async function handleAnalyze() {
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const model = loadSettings().ai_model;
      const body: Record<string, unknown> = { scope, model };
      if (scope === "checked") body.backtest_run_ids = Array.from(checkedStrategyIds);
      if (scope === "run")     body.run_ids = scopeRunIds;

      const res = await fetchWithAuth(`${API_BASE}/api/g-optimize/analyze`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify(body),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error((err as { detail?: string }).detail ?? `HTTP ${res.status}`);
      }
      setResult(await res.json());
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  // -------------------------------------------------------------------------
  // Render helpers
  // -------------------------------------------------------------------------
  function rankLabel(rank: number): string {
    return `★ #${rank}`;
  }

  function copilotHref(rec: Recommendation): string {
    const sid = result?.strategy_ids?.[rec.backtest_run_id];
    return sid ? `/copilot?strategy_id=${sid}` : `/copilot`;
  }

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------
  return (
    <div className="shrink-0 border-t border-zinc-800 bg-zinc-900/40">
      {/* ── Header row ────────────────────────────────────────────────── */}
      <div className="flex items-center gap-3 px-4 py-2 border-b border-zinc-800/60">
        <span className="text-[10px] font-semibold text-zinc-400 uppercase tracking-wide shrink-0">
          Co-Pilot Analysis
        </span>

        {/* Scope radios */}
        <div className="flex items-center gap-3 text-[10px]">
          {(["checked", "run", "all"] as Scope[]).map((s) => (
            <label key={s} className="flex items-center gap-1 cursor-pointer">
              <input
                type="radio"
                className="accent-blue-500"
                name="g_opt_scope"
                checked={scope === s}
                onChange={() => { setScope(s); setResult(null); setError(null); }}
              />
              <span className={scope === s ? "text-zinc-300" : "text-zinc-500"}>
                {s === "checked" ? "Checked strategies" :
                 s === "run"     ? "All from checked runs" :
                                   "All from all runs"}
              </span>
            </label>
          ))}
        </div>

        {/* Summary */}
        <span className="text-[10px] text-zinc-600 truncate">{summaryLabel()}</span>

        {/* Send button */}
        <button
          onClick={handleAnalyze}
          disabled={!canSend || loading}
          className="ml-auto shrink-0 rounded border border-blue-700 px-2 py-0.5 text-[10px] text-blue-400 hover:bg-blue-900/30 disabled:opacity-30 disabled:cursor-not-allowed transition-colors font-medium"
        >
          {loading ? "Analysing…" : "✦ Analyse"}
        </button>
      </div>

      {/* ── Results ───────────────────────────────────────────────────── */}
      {(result || error) && (
        <div className="max-h-72 overflow-y-auto px-4 py-3 space-y-3">
          {error && (
            <p className="text-[11px] text-red-400 border border-red-800 rounded px-2 py-1 bg-red-900/10">
              {error}
            </p>
          )}

          {result && result.recommendations.length === 0 && !result.skipped_reason && (
            <p className="text-[11px] text-zinc-500">No recommendations returned.</p>
          )}

          {result?.recommendations.map((rec) => (
            <div
              key={rec.backtest_run_id}
              className="border border-zinc-700/60 rounded p-3 bg-zinc-800/30 space-y-1.5"
            >
              {/* Rank + summary */}
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className="text-yellow-400 text-[11px] font-semibold shrink-0">
                    {rankLabel(rec.rank)}
                  </span>
                  <span className="text-[11px] text-zinc-200 font-medium">{rec.summary}</span>
                </div>
                <Link
                  href={copilotHref(rec)}
                  className="shrink-0 rounded border border-blue-700 px-1.5 py-0.5 text-[9px] text-blue-400 hover:bg-blue-900/30 transition-colors whitespace-nowrap"
                >
                  Open in Co-Pilot →
                </Link>
              </div>

              {/* Rationale */}
              <p className="text-[10px] text-zinc-400 leading-relaxed">{rec.rationale}</p>

              {/* Refinement */}
              {rec.suggested_refinement && (
                <div className="flex items-start gap-1 text-[10px]">
                  <span className="text-zinc-600 shrink-0">Refine:</span>
                  <span className="text-zinc-400">{rec.suggested_refinement}</span>
                </div>
              )}
            </div>
          ))}

          {/* Skipped note */}
          {result && result.skipped.length > 0 && (
            <p className="text-[10px] text-zinc-500">
              ⚠ Skipped {result.skipped.length} strateg{result.skipped.length !== 1 ? "ies" : "y"} with &lt; 50 trades (low confidence)
              {result.skipped_reason ? ` — ${result.skipped_reason}` : ""}
            </p>
          )}

          {result && result.skipped.length === 0 && result.skipped_reason && (
            <p className="text-[10px] text-zinc-500">{result.skipped_reason}</p>
          )}
        </div>
      )}

      {/* Empty state (no result yet) */}
      {!result && !error && !loading && (
        <div className="px-4 py-1.5">
          <p className="text-[10px] text-zinc-600">
            {canSend
              ? "Click ✦ Analyse to rank strategies with Co-Pilot."
              : scope === "checked"
              ? "Check strategies in the table above to begin analysis."
              : "Select a run to begin analysis."}
          </p>
        </div>
      )}
    </div>
  );
}
