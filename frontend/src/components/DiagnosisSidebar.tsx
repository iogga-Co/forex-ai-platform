"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { fetchWithAuth } from "@/lib/auth";
import { mergeIrPatch, type StrategyIR } from "@/lib/irPatch";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface Finding {
  id: string;
  finding: string;
  action_label: string;
  ir_patch: Partial<StrategyIR>;
  confidence: "high" | "medium" | "low";
}

interface Props {
  backtestRunId: string;
  strategyId: string;
  strategyIr: StrategyIR;
  pair: string;
  timeframe: string;
  periodStart: string;
  periodEnd: string;
  onClose: () => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------
export default function DiagnosisSidebar({
  backtestRunId,
  strategyIr,
  pair,
  timeframe,
  periodStart,
  periodEnd,
  onClose,
}: Props) {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [findings, setFindings] = useState<Finding[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [applying, setApplying] = useState<string | null>(null);

  // Trigger diagnosis on mount (or when backtestRunId changes)
  useEffect(() => {
    setLoading(true);
    setFindings([]);
    setError(null);
    setDismissed(new Set());

    fetchWithAuth("/api/diagnosis/strategy", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ backtest_run_id: backtestRunId }),
    })
      .then((r) => {
        if (!r.ok) throw new Error(`Diagnosis failed (${r.status})`);
        return r.json();
      })
      .then((data) => setFindings(data.findings ?? []))
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, [backtestRunId]);

  async function applyFix(finding: Finding) {
    setApplying(finding.id);
    try {
      const patchedIr = mergeIrPatch(strategyIr, finding.ir_patch);
      const name = `[Fix: ${finding.action_label}] ${pair} ${timeframe}`;

      const res = await fetchWithAuth("/api/strategies", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ir_json: patchedIr,
          description: name,
          pair,
          timeframe,
        }),
      });
      if (!res.ok) throw new Error("Failed to save strategy variant");
      const newStrategy = await res.json();

      const params = new URLSearchParams({
        strategy_id: newStrategy.id,
        pair,
        timeframe,
        period_start: periodStart,
        period_end:   periodEnd,
      });
      router.push(`/backtest?${params.toString()}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to apply fix");
    } finally {
      setApplying(null);
    }
  }

  function dismiss(id: string) {
    setDismissed((prev) => new Set([...prev, id]));
  }

  const visible = findings.filter((f) => !dismissed.has(f.id));

  const confidenceColour: Record<string, string> = {
    high:   "text-red-400 border-red-800 bg-red-900/20",
    medium: "text-yellow-400 border-yellow-800 bg-yellow-900/20",
    low:    "text-slate-400 border-slate-700 bg-slate-800",
  };

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------
  return (
    <div className="fixed right-0 top-0 h-full w-80 bg-slate-900 border-l border-slate-700 shadow-xl z-50 flex flex-col">

      {/* Header */}
      <div className="px-4 py-3 border-b border-slate-700 flex items-center justify-between shrink-0">
        <p className="text-sm font-medium text-slate-200">Diagnose Strategy</p>
        <button
          onClick={onClose}
          className="text-slate-500 hover:text-slate-300 transition-colors text-lg leading-none"
        >
          ✕
        </button>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto py-3 space-y-3">

        {loading && (
          <div className="px-4 py-8 text-center space-y-3">
            <div className="w-5 h-5 border-2 border-blue-500 border-t-transparent rounded-full animate-spin mx-auto" />
            <p className="text-xs text-slate-500">Analyzing backtest results…</p>
          </div>
        )}

        {error && !loading && (
          <p className="px-4 text-xs text-red-400">{error}</p>
        )}

        {!loading && !error && findings.length === 0 && (
          <p className="px-4 text-xs text-slate-500">No significant issues detected.</p>
        )}

        {!loading && !error && findings.length > 0 && visible.length === 0 && (
          <p className="px-4 text-xs text-slate-500">All suggestions dismissed.</p>
        )}

        {visible.map((f) => (
          <div key={f.id} className="rounded-lg border border-slate-700 bg-slate-800 p-3 space-y-2 mx-3">

            {/* Finding + confidence badge */}
            <div className="flex items-start justify-between gap-2">
              <p className="text-xs text-slate-200 leading-relaxed flex-1">{f.finding}</p>
              <span
                className={`shrink-0 inline-flex rounded-full border px-1.5 py-0.5 text-[10px] font-medium ${confidenceColour[f.confidence] ?? confidenceColour.low}`}
              >
                {f.confidence}
              </span>
            </div>

            {/* Actions */}
            <div className="flex items-center justify-between gap-2 pt-1 border-t border-slate-700/60">
              <button
                onClick={() => applyFix(f)}
                disabled={applying === f.id}
                className="flex-1 rounded border border-blue-700 px-2 py-1 text-[11px] text-blue-400 hover:bg-blue-900/30 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {applying === f.id ? "Saving…" : f.action_label}
              </button>
              <button
                onClick={() => dismiss(f.id)}
                className="text-[10px] text-slate-500 hover:text-slate-300 transition-colors shrink-0"
              >
                Ignore
              </button>
            </div>
          </div>
        ))}
      </div>

      {/* Footer */}
      {!loading && visible.length > 0 && (
        <div className="px-4 py-2 border-t border-slate-700 shrink-0">
          <p className="text-[10px] text-slate-600 leading-relaxed">
            Applying a fix creates a new strategy variant. Your original is unchanged.
          </p>
        </div>
      )}
    </div>
  );
}
