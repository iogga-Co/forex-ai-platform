"use client";

import { fetchWithAuth } from "@/lib/auth";
import { useEffect, useState } from "react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface TradePattern {
  label: string;
  finding: string;
  strength: "strong" | "moderate" | "weak";
  recommendation: string;
}

interface TradeAnalysis {
  headline: string;
  patterns: TradePattern[];
  verdict: "structural" | "edge_decay" | "outlier" | "inconclusive";
  recommendation: string;
}

interface Props {
  backtestRunId: string;
  tradeIds: string[];
  onClose: () => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------
export default function TradeAnalysisSidebar({ backtestRunId, tradeIds, onClose }: Props) {
  const [loading, setLoading] = useState(true);
  const [analysis, setAnalysis] = useState<TradeAnalysis | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setAnalysis(null);
    setError(null);

    // Step 1: get pre-computed stats
    fetchWithAuth("/api/diagnosis/trades/stats", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ backtest_run_id: backtestRunId, trade_ids: tradeIds }),
    })
      .then((r) => {
        if (!r.ok) throw new Error(`Stats failed (${r.status})`);
        return r.json();
      })
      // Step 2: send stats to AI analysis
      .then((statsData) =>
        fetchWithAuth("/api/diagnosis/trades/analyze", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            backtest_run_id: backtestRunId,
            trade_ids: tradeIds,
            stats: { selection: statsData.selection, population: statsData.population },
          }),
        }).then((r) => {
          if (!r.ok) throw new Error(`Analysis failed (${r.status})`);
          return r.json();
        })
      )
      .then((data) => setAnalysis(data))
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, [backtestRunId, tradeIds]);

  const strengthColour: Record<string, string> = {
    strong:   "text-red-400 border-red-800 bg-red-900/20",
    moderate: "text-yellow-400 border-yellow-800 bg-yellow-900/20",
    weak:     "text-slate-400 border-slate-700 bg-slate-800",
  };

  const verdictColour: Record<string, string> = {
    structural:   "text-orange-400 border-orange-800 bg-orange-900/20",
    edge_decay:   "text-red-400 border-red-800 bg-red-900/20",
    outlier:      "text-blue-400 border-blue-800 bg-blue-900/20",
    inconclusive: "text-slate-400 border-slate-700 bg-slate-800",
  };

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------
  return (
    <div className="fixed right-0 top-0 h-full w-80 bg-slate-900 border-l border-slate-700 shadow-xl z-50 flex flex-col">

      {/* Header */}
      <div className="px-4 py-3 border-b border-slate-700 flex items-center justify-between shrink-0">
        <p className="text-sm font-medium text-slate-200">
          Trade Pattern Analysis · {tradeIds.length} trades
        </p>
        <button
          onClick={onClose}
          className="text-slate-500 hover:text-slate-300 transition-colors text-lg leading-none"
        >
          ✕
        </button>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto">

        {loading && (
          <div className="px-4 py-8 text-center space-y-3">
            <div className="w-5 h-5 border-2 border-blue-500 border-t-transparent rounded-full animate-spin mx-auto" />
            <p className="text-xs text-slate-500">Analyzing {tradeIds.length} trades…</p>
          </div>
        )}

        {error && !loading && (
          <p className="px-4 py-4 text-xs text-red-400">{error}</p>
        )}

        {analysis && !loading && (
          <>
            {/* Headline */}
            <div className="px-4 py-3 border-b border-slate-700">
              <p className="text-sm text-slate-200 leading-relaxed">{analysis.headline}</p>
            </div>

            {/* Pattern cards */}
            <div className="py-3 space-y-3">
              {analysis.patterns.map((p, i) => (
                <div key={i} className="rounded-lg border border-slate-700 bg-slate-800 p-3 space-y-1.5 mx-3">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-[10px] uppercase tracking-widest text-slate-400">{p.label}</p>
                    <span className={`shrink-0 inline-flex rounded-full border px-1.5 py-0.5 text-[10px] font-medium ${strengthColour[p.strength] ?? strengthColour.weak}`}>
                      {p.strength}
                    </span>
                  </div>
                  <p className="text-xs text-slate-200 leading-relaxed">{p.finding}</p>
                  <p className="text-xs text-blue-400 leading-relaxed">{p.recommendation}</p>
                </div>
              ))}
            </div>

            {/* Verdict + overall recommendation */}
            {(analysis.verdict || analysis.recommendation) && (
              <div className="mx-3 mb-3 rounded-lg border border-slate-700 bg-slate-800/40 p-3 space-y-2">
                {analysis.verdict && (
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] uppercase tracking-widest text-slate-500">Verdict</span>
                    <span className={`inline-flex rounded-full border px-1.5 py-0.5 text-[10px] font-medium ${verdictColour[analysis.verdict] ?? verdictColour.inconclusive}`}>
                      {analysis.verdict.replace("_", " ")}
                    </span>
                  </div>
                )}
                {analysis.recommendation && (
                  <p className="text-xs text-slate-300 leading-relaxed">{analysis.recommendation}</p>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
