"use client";

import { useEffect, useState } from "react";
import { fetchWithAuth } from "@/lib/auth";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Pattern {
  label: string;
  finding: string;
}

interface DiagnosisResult {
  summary: string;
  patterns: Pattern[];
  verdict: "structural" | "edge_decay" | "outlier" | "inconclusive";
  recommendation: string;
}

interface Props {
  backtestRunId: string;
  periodStart: string;   // ISO string
  periodEnd: string;     // ISO string
  tradeCount: number;
  onClose: () => void;
}

// ---------------------------------------------------------------------------
// Verdict config
// ---------------------------------------------------------------------------

const VERDICT_CONFIG = {
  structural:   { label: "Structural",    cls: "bg-orange-900/40 text-orange-400 border border-orange-800" },
  edge_decay:   { label: "Edge Decay",    cls: "bg-red-900/40 text-red-400 border border-red-800" },
  outlier:      { label: "Outlier",       cls: "bg-blue-900/40 text-blue-400 border border-blue-800" },
  inconclusive: { label: "Inconclusive",  cls: "bg-zinc-800 text-zinc-400 border border-zinc-700" },
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function DiagnosisPanel({
  backtestRunId,
  periodStart,
  periodEnd,
  tradeCount,
  onClose,
}: Props) {
  const [loading, setLoading] = useState(true);
  const [result, setResult] = useState<DiagnosisResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function run() {
      setLoading(true);
      setError(null);
      try {
        const data = await fetchWithAuth("/api/diagnosis/period", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            backtest_run_id: backtestRunId,
            period_start: periodStart,
            period_end: periodEnd,
            include_news: true,
          }),
        });
        setResult(data as DiagnosisResult);
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : "Analysis failed. Please try again.");
      } finally {
        setLoading(false);
      }
    }
    run();
  }, [backtestRunId, periodStart, periodEnd]);

  function formatDate(iso: string): string {
    return new Date(iso).toLocaleDateString("en-US", {
      month: "short", day: "numeric", year: "numeric", timeZone: "UTC",
    });
  }

  return (
    <div className="flex flex-col h-full border-l border-zinc-800 bg-zinc-950 overflow-y-auto">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2.5 border-b border-zinc-800 flex-shrink-0">
        <div>
          <div className="text-xs font-semibold text-zinc-200">Period Diagnosis</div>
          <div className="text-[10px] text-zinc-500 mt-0.5">
            {formatDate(periodStart)} — {formatDate(periodEnd)}
            <span className="ml-1 text-zinc-600">· {tradeCount} trades</span>
          </div>
        </div>
        <button
          onClick={onClose}
          className="text-zinc-500 hover:text-zinc-300 transition-colors p-1"
          aria-label="Close"
        >
          <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* Body */}
      <div className="flex-1 px-3 py-3 space-y-4 overflow-y-auto">

        {/* Loading */}
        {loading && (
          <div className="flex flex-col items-center justify-center py-10 gap-2">
            <div className="h-5 w-5 rounded-full border-2 border-zinc-600 border-t-blue-400 animate-spin" />
            <span className="text-[11px] text-zinc-500">Analyzing trades…</span>
          </div>
        )}

        {/* Error */}
        {!loading && error && (
          <div className="rounded border border-red-800 bg-red-900/20 px-3 py-2 text-xs text-red-400">
            {error}
          </div>
        )}

        {/* Result */}
        {!loading && result && (
          <>
            {/* Summary */}
            <div>
              <div className="text-[10px] font-semibold text-zinc-500 uppercase tracking-wide mb-1">
                Summary
              </div>
              <p className="text-xs text-zinc-300 leading-relaxed">{result.summary}</p>
            </div>

            {/* Verdict */}
            <div>
              <div className="text-[10px] font-semibold text-zinc-500 uppercase tracking-wide mb-1">
                Verdict
              </div>
              {(() => {
                const cfg = VERDICT_CONFIG[result.verdict] ?? VERDICT_CONFIG.inconclusive;
                return (
                  <span className={`inline-flex rounded px-2 py-0.5 text-xs font-medium ${cfg.cls}`}>
                    {cfg.label}
                  </span>
                );
              })()}
            </div>

            {/* Patterns */}
            {result.patterns.length > 0 && (
              <div>
                <div className="text-[10px] font-semibold text-zinc-500 uppercase tracking-wide mb-1.5">
                  Patterns Found
                </div>
                <div className="space-y-2">
                  {result.patterns.map((p, i) => (
                    <div
                      key={i}
                      className="rounded border border-zinc-800 bg-zinc-900/50 px-2.5 py-2"
                    >
                      <div className="text-[10px] font-semibold text-zinc-400 mb-0.5">
                        {p.label}
                      </div>
                      <div className="text-[11px] text-zinc-300 leading-relaxed">
                        {p.finding}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Recommendation */}
            <div>
              <div className="text-[10px] font-semibold text-zinc-500 uppercase tracking-wide mb-1">
                Recommendation
              </div>
              <p className="text-xs text-zinc-300 leading-relaxed">{result.recommendation}</p>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
