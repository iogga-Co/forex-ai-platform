"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "";

function entryCount(ir: Record<string, unknown>): number {
  const conditions = ir.entry_conditions;
  return Array.isArray(conditions) ? conditions.length : 0;
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------
function StrategyCard({ s, onDeleted }: { s: Strategy; onDeleted: (id: string) => void }) {
  const [expanded, setExpanded] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);

  async function handleDelete() {
    const token = typeof window !== "undefined" ? localStorage.getItem("access_token") : null;
    setDeleting(true);
    try {
      const res = await fetch(`${API_BASE}/api/strategies/${s.id}`, {
        method: "DELETE",
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      onDeleted(s.id);
    } catch {
      setDeleting(false);
      setConfirming(false);
    }
  }

  return (
    <div className="rounded-lg border border-surface-border bg-surface-raised p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-xs font-mono text-accent">{s.pair}</span>
            <span className="text-xs text-gray-500">{s.timeframe}</span>
            <span className="text-xs text-gray-600">v{s.version}</span>
          </div>
          <p className="text-sm text-gray-200 truncate">{s.description}</p>
          <p className="text-xs text-gray-600 mt-1">
            {entryCount(s.ir_json)} entry condition{entryCount(s.ir_json) !== 1 ? "s" : ""}
          </p>
        </div>
        <div className="flex gap-2 shrink-0 items-center">
          <button
            onClick={() => setExpanded((v) => !v)}
            className="rounded-md border border-surface-border px-3 py-1.5 text-xs text-gray-400 hover:text-gray-100 transition-colors"
          >
            {expanded ? "Hide IR" : "View IR"}
          </button>
          <Link
            href={`/backtest?strategy_id=${s.id}&pair=${s.pair}&timeframe=${s.timeframe}`}
            className="rounded-md bg-accent px-3 py-1.5 text-xs text-white hover:bg-accent/80 transition-colors"
          >
            Backtest
          </Link>
          {confirming ? (
            <>
              <button
                onClick={handleDelete}
                disabled={deleting}
                className="rounded-md bg-red-600 px-3 py-1.5 text-xs text-white hover:bg-red-500 transition-colors disabled:opacity-50"
              >
                {deleting ? "Deleting…" : "Confirm"}
              </button>
              <button
                onClick={() => setConfirming(false)}
                disabled={deleting}
                className="rounded-md border border-surface-border px-3 py-1.5 text-xs text-gray-400 hover:text-gray-100 transition-colors"
              >
                Cancel
              </button>
            </>
          ) : (
            <button
              onClick={() => setConfirming(true)}
              title="Delete strategy"
              className="rounded-md border border-red-800 p-1.5 text-red-400 hover:bg-red-900/30 transition-colors"
            >
              <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="3 6 5 6 21 6" />
                <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                <path d="M10 11v6" />
                <path d="M14 11v6" />
                <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
              </svg>
            </button>
          )}
        </div>
      </div>

      {expanded && (
        <pre className="mt-4 rounded-md bg-surface p-3 text-xs text-gray-300 font-mono overflow-x-auto whitespace-pre-wrap border border-surface-border">
          {JSON.stringify(s.ir_json, null, 2)}
        </pre>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------
export default function StrategiesPage() {
  const [strategies, setStrategies] = useState<Strategy[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const token = typeof window !== "undefined" ? localStorage.getItem("access_token") : null;
    fetch(`${API_BASE}/api/strategies`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    })
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<Strategy[]>;
      })
      .then((data) => {
        setStrategies(data);
        setLoading(false);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      });
  }, []);

  return (
    <div className="max-w-3xl">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-semibold text-gray-100">Strategies</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            All saved strategy versions. Use the AI Co-Pilot to generate new ones.
          </p>
        </div>
        <Link
          href="/copilot"
          className="rounded-md bg-accent px-4 py-2 text-sm text-white hover:bg-accent/80 transition-colors"
        >
          + New via Co-Pilot
        </Link>
      </div>

      {loading && (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <div
              key={i}
              className="h-20 rounded-lg border border-surface-border bg-surface-raised animate-pulse"
            />
          ))}
        </div>
      )}

      {error && (
        <p className="text-sm text-red-400">Failed to load strategies: {error}</p>
      )}

      {!loading && !error && strategies.length === 0 && (
        <div className="rounded-lg border border-surface-border bg-surface-raised p-8 text-center">
          <p className="text-sm text-gray-500">No strategies yet.</p>
          <Link
            href="/copilot"
            className="mt-3 inline-block text-sm text-accent hover:underline"
          >
            Create one with the AI Co-Pilot →
          </Link>
        </div>
      )}

      {!loading && !error && strategies.length > 0 && (
        <div className="space-y-3">
          {strategies.map((s) => (
            <StrategyCard
              key={s.id}
              s={s}
              onDeleted={(id) => setStrategies((prev) => prev.filter((x) => x.id !== id))}
            />
          ))}
        </div>
      )}
    </div>
  );
}
