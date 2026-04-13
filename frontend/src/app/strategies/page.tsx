"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { fetchWithAuth } from "@/lib/auth";
import BacktestResultPanel from "@/components/BacktestResultPanel";
import { loadSettings } from "@/lib/settings";

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

interface RunSummary {
  id: string;
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
const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "";

function entryCount(ir: Record<string, unknown>): number {
  const conditions = ir.entry_conditions;
  return Array.isArray(conditions) ? conditions.length : 0;
}

function fmt(v: number | null, d = 2) {
  return v == null ? "—" : v.toFixed(d);
}
function fmtPct(v: number | null) {
  return v == null ? "—" : (v * 100).toFixed(1) + "%";
}
function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-GB", {
    day: "2-digit", month: "short", year: "numeric",
  });
}

// ---------------------------------------------------------------------------
// Active strategy card
// ---------------------------------------------------------------------------
function StrategyCard({
  s,
  selected,
  onSelect,
  onDeleted,
}: {
  s: Strategy;
  selected: boolean;
  onSelect: (id: string) => void;
  onDeleted: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);

  async function handleDelete() {
    setDeleting(true);
    try {
      const res = await fetchWithAuth(`${API_BASE}/api/strategies/${s.id}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      onDeleted(s.id);
    } catch {
      setDeleting(false);
      setConfirming(false);
    }
  }

  return (
    <div
      className={[
        "rounded-lg border p-4 cursor-pointer transition-colors",
        selected
          ? "border-accent bg-accent/10"
          : "border-surface-border bg-surface-raised hover:border-accent/50",
      ].join(" ")}
      onClick={() => onSelect(s.id)}
    >
      {/* Top: description */}
      <div className="mb-3">
        <div className="flex items-center gap-2 mb-1">
          <span className="text-xs font-mono text-accent">{s.pair}</span>
          <span className="text-xs text-gray-500">{s.timeframe}</span>
          <span className="text-xs text-gray-600">v{s.version}</span>
        </div>
        <p className="text-sm text-gray-200">{s.description}</p>
        <p className="text-xs text-gray-600 mt-1">
          {entryCount(s.ir_json)} entry condition{entryCount(s.ir_json) !== 1 ? "s" : ""}
        </p>
      </div>

      {/* Bottom: action buttons */}
      <div className="flex gap-2 items-center flex-wrap">
        <button
          onClick={(e) => { e.stopPropagation(); setExpanded((v) => !v); }}
          className="rounded-md border border-blue-700 px-3 py-1.5 text-xs text-blue-400 hover:bg-blue-900/30 transition-colors"
        >
          {expanded ? "Hide IR" : "View IR"}
        </button>
        <Link
          href={`/backtest?strategy_id=${s.id}&pair=${s.pair}&timeframe=${s.timeframe}`}
          onClick={(e) => e.stopPropagation()}
          className="rounded-md border border-blue-700 px-3 py-1.5 text-xs text-blue-400 hover:bg-blue-900/30 transition-colors"
        >
          Backtest
        </Link>
        <Link
          href={`/optimization?strategy_id=${s.id}&pair=${s.pair}&timeframe=${s.timeframe}`}
          onClick={(e) => e.stopPropagation()}
          className="rounded-md border border-blue-700 px-3 py-1.5 text-xs text-blue-400 hover:bg-blue-900/30 transition-colors"
        >
          Refine
        </Link>
        {confirming ? (
          <>
            <button
              onClick={(e) => { e.stopPropagation(); handleDelete(); }}
              disabled={deleting}
              className="rounded-md bg-red-600 px-3 py-1.5 text-xs text-white hover:bg-red-500 transition-colors disabled:opacity-50"
            >
              {deleting ? "Deleting…" : "Confirm"}
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); setConfirming(false); }}
              disabled={deleting}
              className="rounded-md border border-blue-700 px-3 py-1.5 text-xs text-blue-400 hover:bg-blue-900/30 transition-colors"
            >
              Cancel
            </button>
          </>
        ) : (
          <button
            onClick={(e) => { e.stopPropagation(); setConfirming(true); }}
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

      {expanded && (
        <pre className="mt-4 rounded-md bg-surface p-3 text-xs text-gray-300 font-mono overflow-x-auto whitespace-pre-wrap border border-surface-border">
          {JSON.stringify(s.ir_json, null, 2)}
        </pre>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Deleted strategy card
// ---------------------------------------------------------------------------
function DeletedStrategyCard({
  s,
  onRestored,
}: {
  s: Strategy;
  onRestored: (s: Strategy) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [restoring, setRestoring] = useState(false);

  async function handleRestore() {
    setRestoring(true);
    try {
      const res = await fetchWithAuth(`${API_BASE}/api/strategies/${s.id}/restore`, {
        method: "POST",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const restored: Strategy = await res.json();
      onRestored(restored);
    } catch {
      setRestoring(false);
    }
  }

  return (
    <div className="rounded-lg border border-surface-border bg-surface-raised p-4 opacity-70">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-xs font-mono text-accent">{s.pair}</span>
            <span className="text-xs text-gray-500">{s.timeframe}</span>
            <span className="text-xs text-gray-600">v{s.version}</span>
            <span className="text-xs text-red-500 font-medium">deleted</span>
          </div>
          <p className="text-sm text-gray-400 truncate">{s.description}</p>
          <p className="text-xs text-gray-600 mt-1">
            {entryCount(s.ir_json)} entry condition{entryCount(s.ir_json) !== 1 ? "s" : ""}
          </p>
        </div>
        <div className="flex gap-2 shrink-0 items-center">
          <button
            onClick={() => setExpanded((v) => !v)}
            className="rounded-md border border-blue-700 px-3 py-1.5 text-xs text-blue-400 hover:bg-blue-900/30 transition-colors"
          >
            {expanded ? "Hide IR" : "View IR"}
          </button>
          <button
            onClick={handleRestore}
            disabled={restoring}
            title="Restore strategy"
            className="rounded-md border border-blue-700 px-3 py-1.5 text-xs text-blue-400 hover:bg-blue-900/30 transition-colors disabled:opacity-50"
          >
            {restoring ? "Restoring…" : "Restore"}
          </button>
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
  const [tab, setTab] = useState<"active" | "deleted">("active");
  const [active, setActive] = useState<Strategy[]>([]);
  const [deleted, setDeleted] = useState<Strategy[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [selectedStrategyId, setSelectedStrategyId] = useState<string | null>(null);
  const [backtests, setBacktests] = useState<RunSummary[]>([]);
  const [loadingBacktests, setLoadingBacktests] = useState(false);
  const [selectedBacktestId, setSelectedBacktestId] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    Promise.all([
      fetchWithAuth(`${API_BASE}/api/strategies`).then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<Strategy[]>;
      }),
      fetchWithAuth(`${API_BASE}/api/strategies/deleted`).then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<Strategy[]>;
      }),
    ])
      .then(([activeList, deletedList]) => {
        setActive(activeList);
        setDeleted(deletedList);
        setLoading(false);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      });
  }, []);

  function handleSelectStrategy(id: string) {
    if (selectedStrategyId === id) return;
    setSelectedStrategyId(id);
    setSelectedBacktestId(null);
    setBacktests([]);
    setLoadingBacktests(true);
    const { backtest_history_limit } = loadSettings();
    fetchWithAuth(`${API_BASE}/api/backtest/results?strategy_id=${id}&limit=${backtest_history_limit}`)
      .then((r) => r.json())
      .then((data: RunSummary[]) => setBacktests(Array.isArray(data) ? data : []))
      .catch(() => setBacktests([]))
      .finally(() => setLoadingBacktests(false));
  }

  function handleDeleted(id: string) {
    const strategy = active.find((s) => s.id === id);
    setActive((prev) => prev.filter((s) => s.id !== id));
    if (strategy) setDeleted((prev) => [strategy, ...prev]);
    if (selectedStrategyId === id) {
      setSelectedStrategyId(null);
      setBacktests([]);
      setSelectedBacktestId(null);
    }
  }

  function handleRestored(s: Strategy) {
    setDeleted((prev) => prev.filter((d) => d.id !== s.id));
    setActive((prev) => [s, ...prev]);
  }

  const selectedStrategy = active.find((s) => s.id === selectedStrategyId);

  return (
    <div className="flex h-full overflow-hidden -m-6">

      {/* ── Left panel: strategy list ── */}
      <div className="w-[420px] shrink-0 flex flex-col overflow-hidden border-r border-surface-border">
        {/* Header */}
        <div className="px-6 pt-6 pb-4 shrink-0">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h1 className="text-xl font-semibold text-gray-100">Strategies</h1>
              <p className="text-sm text-gray-500 mt-0.5">
                Click a strategy to view its backtests.
              </p>
            </div>
            <Link
              href="/copilot"
              className="rounded-md border border-blue-700 px-4 py-2 text-sm text-blue-400 hover:bg-blue-900/30 transition-colors shrink-0"
            >
              + New
            </Link>
          </div>

          {/* Tab toggle */}
          <div className="flex gap-1 border-b border-surface-border">
            <button
              onClick={() => setTab("active")}
              className={`px-4 py-2 text-sm transition-colors border-b-2 -mb-px ${
                tab === "active"
                  ? "border-accent text-gray-100"
                  : "border-transparent text-gray-500 hover:text-gray-300"
              }`}
            >
              Active
              {active.length > 0 && (
                <span className="ml-2 text-xs text-gray-600">{active.length}</span>
              )}
            </button>
            <button
              onClick={() => setTab("deleted")}
              className={`px-4 py-2 text-sm transition-colors border-b-2 -mb-px ${
                tab === "deleted"
                  ? "border-accent text-gray-100"
                  : "border-transparent text-gray-500 hover:text-gray-300"
              }`}
            >
              Deleted
              {deleted.length > 0 && (
                <span className="ml-2 text-xs text-gray-600">{deleted.length}</span>
              )}
            </button>
          </div>
        </div>

        {/* List */}
        <div className="flex-1 overflow-y-auto px-6 pb-6 space-y-3">
          {loading && [1, 2, 3].map((i) => (
            <div key={i} className="h-20 rounded-lg border border-surface-border bg-surface-raised animate-pulse" />
          ))}

          {error && (
            <p className="text-sm text-red-400">Failed to load strategies: {error}</p>
          )}

          {!loading && !error && tab === "active" && (
            active.length === 0 ? (
              <div className="rounded-lg border border-surface-border bg-surface-raised p-8 text-center">
                <p className="text-sm text-gray-500">No active strategies.</p>
                <Link href="/copilot" className="mt-3 inline-block text-sm text-accent hover:underline">
                  Create one with the AI Co-Pilot →
                </Link>
              </div>
            ) : (
              active.map((s) => (
                <StrategyCard
                  key={s.id}
                  s={s}
                  selected={selectedStrategyId === s.id}
                  onSelect={handleSelectStrategy}
                  onDeleted={handleDeleted}
                />
              ))
            )
          )}

          {!loading && !error && tab === "deleted" && (
            deleted.length === 0 ? (
              <div className="rounded-lg border border-surface-border bg-surface-raised p-8 text-center">
                <p className="text-sm text-gray-500">No deleted strategies.</p>
              </div>
            ) : (
              deleted.map((s) => (
                <DeletedStrategyCard key={s.id} s={s} onRestored={handleRestored} />
              ))
            )
          )}
        </div>
      </div>

      {/* ── Middle panel: backtest list for selected strategy ── */}
      {selectedStrategyId && (
        <div className="w-72 shrink-0 flex flex-col overflow-hidden border-r border-surface-border">
          <div className="px-4 py-4 border-b border-surface-border shrink-0">
            <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide">Backtests</p>
            {selectedStrategy && (
              <p className="text-xs text-gray-500 mt-0.5 truncate">{selectedStrategy.description}</p>
            )}
          </div>
          <div className="flex-1 overflow-y-auto px-3 py-3 space-y-1.5">
            {loadingBacktests && (
              <div className="space-y-1.5">
                {[1, 2, 3].map((i) => (
                  <div key={i} className="h-16 rounded-lg border border-surface-border bg-surface-raised animate-pulse" />
                ))}
              </div>
            )}
            {!loadingBacktests && backtests.length === 0 && (
              <div className="pt-8 text-center">
                <p className="text-xs text-gray-600">No backtests for this strategy.</p>
                <Link
                  href={`/backtest?strategy_id=${selectedStrategyId}`}
                  className="mt-2 inline-block text-xs text-accent hover:underline"
                >
                  Run one →
                </Link>
              </div>
            )}
            {!loadingBacktests && backtests.map((r) => (
              <div
                key={r.id}
                onClick={() => setSelectedBacktestId(r.id)}
                className={[
                  "rounded-lg border px-3 py-2.5 cursor-pointer transition-colors",
                  selectedBacktestId === r.id
                    ? "border-accent bg-accent/10"
                    : "border-surface-border hover:border-gray-600 hover:bg-surface-raised",
                ].join(" ")}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-medium text-gray-200">{r.pair}</span>
                  <span className="text-xs text-gray-500">{r.timeframe}</span>
                  <span className={`text-xs font-medium ml-auto ${r.total_pnl >= 0 ? "text-green-400" : "text-red-400"}`}>
                    {r.total_pnl >= 0 ? "+" : ""}${fmt(r.total_pnl, 0)}
                  </span>
                </div>
                <div className="flex items-center gap-2 mt-1 text-xs">
                  <span className="text-gray-400">Sh <span className="font-medium">{fmt(r.sharpe)}</span></span>
                  <span className="text-gray-400">WR <span className="font-medium">{fmtPct(r.win_rate)}</span></span>
                  <span className="text-gray-400">Tr <span className="font-medium">{r.trade_count ?? "—"}</span></span>
                </div>
                <div className="flex items-center justify-between mt-0.5 text-[10px] text-gray-600">
                  <span>{r.period_start.slice(0, 10)} → {r.period_end.slice(0, 10)}</span>
                  <span>{fmtDate(r.created_at)}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Right panel: backtest detail ── */}
      {selectedBacktestId ? (
        <div className="flex-1 overflow-y-auto px-6 py-6 min-w-0">
          <BacktestResultPanel
            id={selectedBacktestId}
            onClose={() => setSelectedBacktestId(null)}
          />
        </div>
      ) : (
        <div className="flex-1 flex items-center justify-center text-sm text-gray-700 select-none">
          {selectedStrategyId
            ? backtests.length > 0 ? "← Select a backtest to view results" : ""
            : "← Select a strategy to view its backtests"}
        </div>
      )}
    </div>
  );
}
