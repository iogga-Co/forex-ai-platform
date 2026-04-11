"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { fetchWithAuth } from "@/lib/auth";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface Strategy {
  id: string;
  version: number;
  description: string;
  pair: string;
  timeframe: string;
  ir_json: Record<string, unknown>;
}

interface BacktestRun {
  id: string;
  strategy_id: string;
  pair: string;
  timeframe: string;
  period_start: string;
  period_end: string;
  sharpe: number | null;
  max_dd: number | null;
  win_rate: number | null;
  trade_count: number;
  total_pnl: number;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function fmt(v: number | null, d = 2) {
  return v === null || v === undefined ? "—" : v.toFixed(d);
}
function fmtPct(v: number | null) {
  return v === null || v === undefined ? "—" : (v * 100).toFixed(1) + "%";
}
function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-GB", {
    day: "2-digit", month: "short", year: "numeric",
  });
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------
export default function StrategyDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();

  const [strategy, setStrategy] = useState<Strategy | null>(null);
  const [runs, setRuns] = useState<BacktestRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [irExpanded, setIrExpanded] = useState(false);

  useEffect(() => {
    if (!id) return;
    Promise.all([
      fetchWithAuth(`/api/strategies/${id}`).then((r) => {
        if (!r.ok) throw new Error(`Strategy not found`);
        return r.json() as Promise<Strategy>;
      }),
      fetchWithAuth(`/api/backtest/results?strategy_id=${id}&limit=100`).then((r) => {
        if (!r.ok) throw new Error(`Failed to load backtests`);
        return r.json() as Promise<BacktestRun[]>;
      }),
    ])
      .then(([s, r]) => { setStrategy(s); setRuns(r); })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));
  }, [id]);

  if (loading) {
    return (
      <div className="max-w-4xl space-y-4 animate-pulse">
        <div className="h-6 bg-gray-800 rounded w-64" />
        <div className="h-32 bg-gray-800 rounded-lg" />
        <div className="h-48 bg-gray-800 rounded-lg" />
      </div>
    );
  }

  if (error || !strategy) {
    return <p className="text-sm text-red-400">{error ?? "Strategy not found."}</p>;
  }

  return (
    <div className="max-w-4xl space-y-6">
      {/* Back link */}
      <Link href="/strategies" className="text-xs text-gray-500 hover:text-gray-300 transition-colors">
        ← Back to Strategies
      </Link>

      {/* Strategy header */}
      <div className="rounded-lg border border-surface-border bg-surface-raised p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <span className="text-xs font-mono text-accent">{strategy.pair}</span>
              <span className="text-xs text-gray-500">{strategy.timeframe}</span>
              <span className="text-xs text-gray-600">v{strategy.version}</span>
            </div>
            <h1 className="text-lg font-semibold text-gray-100">{strategy.description}</h1>
          </div>
          <div className="flex gap-2 shrink-0">
            <button
              onClick={() => setIrExpanded((v) => !v)}
              className="rounded-md border border-surface-border px-3 py-1.5 text-xs text-gray-400 hover:text-gray-100 transition-colors"
            >
              {irExpanded ? "Hide IR" : "View IR"}
            </button>
            <Link
              href={`/backtest?strategy_id=${strategy.id}&pair=${strategy.pair}&timeframe=${strategy.timeframe}`}
              className="rounded-md bg-accent px-3 py-1.5 text-xs text-white hover:bg-accent/80 transition-colors"
            >
              New Backtest
            </Link>
          </div>
        </div>

        {irExpanded && (
          <pre className="mt-4 rounded-md bg-surface p-3 text-xs text-gray-300 font-mono overflow-x-auto whitespace-pre-wrap border border-surface-border">
            {JSON.stringify(strategy.ir_json, null, 2)}
          </pre>
        )}
      </div>

      {/* Backtest runs */}
      <div>
        <h2 className="text-sm font-medium text-gray-300 mb-3">
          Backtest History
          <span className="ml-2 text-xs text-gray-600">{runs.length} run{runs.length !== 1 ? "s" : ""}</span>
        </h2>

        {runs.length === 0 ? (
          <div className="rounded-lg border border-surface-border bg-surface-raised p-8 text-center">
            <p className="text-sm text-gray-500">No backtests yet for this strategy.</p>
            <Link
              href={`/backtest?strategy_id=${strategy.id}&pair=${strategy.pair}&timeframe=${strategy.timeframe}`}
              className="mt-3 inline-block text-sm text-accent hover:underline"
            >
              Run the first backtest →
            </Link>
          </div>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-surface-border bg-surface-raised">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-gray-500 border-b border-gray-800">
                  <th className="text-left px-4 py-3 font-normal">Date</th>
                  <th className="text-left px-4 py-3 font-normal">Period</th>
                  <th className="text-left px-4 py-3 font-normal">Pair</th>
                  <th className="text-left px-4 py-3 font-normal">TF</th>
                  <th className="text-right px-4 py-3 font-normal">Sharpe</th>
                  <th className="text-right px-4 py-3 font-normal">Max DD</th>
                  <th className="text-right px-4 py-3 font-normal">Win%</th>
                  <th className="text-right px-4 py-3 font-normal">Trades</th>
                  <th className="text-right px-4 py-3 font-normal">P&amp;L</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-800">
                {runs.map((r) => (
                  <tr key={r.id} className="hover:bg-gray-800/40 transition-colors">
                    <td className="px-4 py-3 text-gray-400 whitespace-nowrap text-xs">
                      {fmtDate(r.created_at)}
                    </td>
                    <td className="px-4 py-3 text-gray-500 whitespace-nowrap text-xs">
                      {r.period_start.slice(0, 10)} → {r.period_end.slice(0, 10)}
                    </td>
                    <td className="px-4 py-3 text-gray-200 font-mono text-xs">{r.pair}</td>
                    <td className="px-4 py-3 text-gray-400 text-xs">{r.timeframe}</td>
                    <td className="px-4 py-3 text-right text-gray-200">{fmt(r.sharpe)}</td>
                    <td className="px-4 py-3 text-right text-red-400">{fmtPct(r.max_dd)}</td>
                    <td className="px-4 py-3 text-right text-gray-200">{fmtPct(r.win_rate)}</td>
                    <td className="px-4 py-3 text-right text-gray-400">{r.trade_count}</td>
                    <td className={`px-4 py-3 text-right font-medium ${r.total_pnl >= 0 ? "text-green-400" : "text-red-400"}`}>
                      {r.total_pnl >= 0 ? "+" : ""}${fmt(r.total_pnl, 0)}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex gap-2 justify-end">
                        <Link
                          href={`/backtest/results/${r.id}`}
                          className="text-xs text-blue-400 hover:underline whitespace-nowrap"
                        >
                          View
                        </Link>
                        <button
                          onClick={() => router.push(
                            `/copilot?strategy_id=${strategy.id}&backtest_id=${r.id}`
                          )}
                          className="text-xs text-accent hover:underline whitespace-nowrap"
                        >
                          Refine
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
