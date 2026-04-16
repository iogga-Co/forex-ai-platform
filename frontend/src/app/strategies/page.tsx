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
// Sort helpers
// ---------------------------------------------------------------------------
type StrategySortKey = "description" | "pair" | "timeframe" | "version" | "entries";
type BacktestSortKey = "created_at" | "sharpe" | "win_rate" | "total_pnl" | "trade_count";
type SortDir = "asc" | "desc";

const STRATEGY_SORT_LABELS: Record<StrategySortKey, string> = {
  description: "Name",
  pair: "Pair",
  timeframe: "TF",
  version: "Ver",
  entries: "Cond",
};

const BACKTEST_SORT_LABELS: Record<BacktestSortKey, string> = {
  created_at: "Date",
  sharpe: "Sharpe",
  win_rate: "WR",
  total_pnl: "PnL",
  trade_count: "Trades",
};

function sortStrategies(list: Strategy[], key: StrategySortKey, dir: SortDir): Strategy[] {
  return [...list].sort((a, b) => {
    let av: string | number, bv: string | number;
    if (key === "entries") { av = entryCount(a.ir_json); bv = entryCount(b.ir_json); }
    else if (key === "version") { av = a.version; bv = b.version; }
    else { av = (a[key as "description" | "pair" | "timeframe"] ?? "").toLowerCase(); bv = (b[key as "description" | "pair" | "timeframe"] ?? "").toLowerCase(); }
    const cmp = av < bv ? -1 : av > bv ? 1 : 0;
    return dir === "asc" ? cmp : -cmp;
  });
}

function sortBacktests(list: RunSummary[], key: BacktestSortKey, dir: SortDir): RunSummary[] {
  return [...list].sort((a, b) => {
    const av = a[key] ?? (dir === "desc" ? -Infinity : Infinity);
    const bv = b[key] ?? (dir === "desc" ? -Infinity : Infinity);
    const cmp = av < bv ? -1 : av > bv ? 1 : 0;
    return dir === "asc" ? cmp : -cmp;
  });
}

// ---------------------------------------------------------------------------
// Strategy card — plain clickable row, no inline buttons
// ---------------------------------------------------------------------------
function StrategyCard({
  s,
  selected,
  checked,
  showIR,
  onSelect,
  onCheck,
}: {
  s: Strategy;
  selected: boolean;
  checked: boolean;
  showIR: boolean;
  onSelect: (id: string) => void;
  onCheck: (id: string, val: boolean) => void;
}) {
  return (
    <div
      className={[
        "rounded-lg border px-3 py-1.5 cursor-pointer transition-colors",
        selected
          ? "border-accent bg-accent/10"
          : checked
          ? "border-blue-800 bg-blue-900/10"
          : "border-surface-border bg-surface-raised hover:border-accent/50",
      ].join(" ")}
      onClick={() => onSelect(s.id)}
    >
      <div className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => onCheck(s.id, e.target.checked)}
          onClick={(e) => e.stopPropagation()}
          className="h-3 w-3 shrink-0 accent-blue-500 cursor-pointer"
        />
        <span className="text-xs font-mono text-accent">{s.pair}</span>
        <span className="text-xs text-gray-500">{s.timeframe}</span>
        <span className="text-xs text-gray-600">v{s.version}</span>
      </div>
      <p className="text-xs text-gray-200 pl-5">{s.description}</p>
      <p className="text-xs text-gray-600 pl-5">
        {entryCount(s.ir_json)} entry condition{entryCount(s.ir_json) !== 1 ? "s" : ""}
      </p>

      {selected && showIR && (
        <pre className="mt-4 rounded-md bg-surface p-3 text-xs text-gray-300 font-mono overflow-x-auto whitespace-pre-wrap border border-surface-border">
          {JSON.stringify(s.ir_json, null, 2)}
        </pre>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Deleted strategy card — restore only
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

  const [strategySortKey, setStrategySortKey] = useState<StrategySortKey>("description");
  const [strategySortDir, setStrategySortDir] = useState<SortDir>("asc");
  const [backtestSortKey, setBacktestSortKey] = useState<BacktestSortKey>("created_at");
  const [backtestSortDir, setBacktestSortDir] = useState<SortDir>("desc");

  const [selectedStrategyId, setSelectedStrategyId] = useState<string | null>(null);
  const [checkedStrategyIds, setCheckedStrategyIds] = useState<Set<string>>(new Set());
  const [backtests, setBacktests] = useState<RunSummary[]>([]);
  const [loadingBacktests, setLoadingBacktests] = useState(false);
  const [selectedBacktestId, setSelectedBacktestId] = useState<string | null>(null);
  const [checkedBacktestIds, setCheckedBacktestIds] = useState<Set<string>>(new Set());

  // Toolbar state
  const [showIR, setShowIR] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);

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
    if (selectedStrategyId === id) {
      setSelectedStrategyId(null);
      setBacktests([]);
      setSelectedBacktestId(null);
      setShowIR(false);
      setConfirming(false);
      return;
    }
    setSelectedStrategyId(id);
    setSelectedBacktestId(null);
    setCheckedBacktestIds(new Set());
    setBacktests([]);
    setShowIR(false);
    setConfirming(false);
    setLoadingBacktests(true);
    const { backtest_history_limit } = loadSettings();
    fetchWithAuth(`${API_BASE}/api/backtest/results?strategy_id=${id}&limit=${backtest_history_limit}`)
      .then((r) => r.json())
      .then((data: RunSummary[]) => setBacktests(Array.isArray(data) ? data : []))
      .catch(() => setBacktests([]))
      .finally(() => setLoadingBacktests(false));
  }

  async function handleDelete() {
    const ids = checkedStrategyIds.size > 0
      ? [...checkedStrategyIds]
      : selectedStrategyId ? [selectedStrategyId] : [];
    if (ids.length === 0) return;
    setDeleting(true);
    try {
      await Promise.allSettled(
        ids.map((id) => fetchWithAuth(`${API_BASE}/api/strategies/${id}`, { method: "DELETE" }))
      );
      const moved = active.filter((s) => ids.includes(s.id));
      setActive((prev) => prev.filter((s) => !ids.includes(s.id)));
      setDeleted((prev) => [...moved, ...prev]);
      if (selectedStrategyId && ids.includes(selectedStrategyId)) {
        setSelectedStrategyId(null);
        setBacktests([]);
        setSelectedBacktestId(null);
      }
      setCheckedStrategyIds(new Set());
      setConfirming(false);
      setShowIR(false);
    } catch {
      // non-fatal
    } finally {
      setDeleting(false);
    }
  }

  function handleRestored(s: Strategy) {
    setDeleted((prev) => prev.filter((d) => d.id !== s.id));
    setActive((prev) => [s, ...prev]);
  }

  const selectedStrategy = active.find((s) => s.id === selectedStrategyId) ?? null;

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
                Click a strategy to select it.
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
          <div className="flex gap-1 border-b border-surface-border mb-3">
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

          {/* Action toolbar — active tab only */}
          {tab === "active" && (
            <div className="space-y-2">
              <div className="flex items-center gap-1 flex-nowrap">
                <Link
                  href={selectedStrategy ? `/superchart?strategy_id=${selectedStrategy.id}` : "#"}
                  onClick={(e) => { if (!selectedStrategy) e.preventDefault(); }}
                  className={`rounded border border-blue-700 px-1.5 py-0.5 text-[10px] text-blue-400 hover:bg-blue-900/30 transition-colors ${!selectedStrategy ? "opacity-30 pointer-events-none" : ""}`}
                >
                  Superchart
                </Link>
                <Link
                  href={selectedStrategy ? `/backtest?strategy_id=${selectedStrategy.id}&pair=${selectedStrategy.pair}&timeframe=${selectedStrategy.timeframe}` : "#"}
                  onClick={(e) => { if (!selectedStrategy) e.preventDefault(); }}
                  className={`rounded border border-blue-700 px-1.5 py-0.5 text-[10px] text-blue-400 hover:bg-blue-900/30 transition-colors ${!selectedStrategy ? "opacity-30 pointer-events-none" : ""}`}
                >
                  Backtest
                </Link>
                <Link
                  href={selectedStrategy ? `/copilot?strategy_id=${selectedStrategy.id}&pair=${selectedStrategy.pair}&timeframe=${selectedStrategy.timeframe}` : "#"}
                  onClick={(e) => { if (!selectedStrategy) e.preventDefault(); }}
                  className={`rounded border border-blue-700 px-1.5 py-0.5 text-[10px] text-blue-400 hover:bg-blue-900/30 transition-colors ${!selectedStrategy ? "opacity-30 pointer-events-none" : ""}`}
                >
                  Refine
                </Link>
                <button
                  disabled={!selectedStrategy}
                  onClick={() => setShowIR((v) => !v)}
                  className="rounded border border-blue-700 px-1.5 py-0.5 text-[10px] text-blue-400 hover:bg-blue-900/30 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                >
                  {showIR ? "Hide IR" : "View IR"}
                </button>
                {confirming ? (
                  <>
                    <button
                      onClick={handleDelete}
                      disabled={deleting}
                      className="rounded bg-red-600 px-1.5 py-0.5 text-[10px] text-white hover:bg-red-500 transition-colors disabled:opacity-50"
                    >
                      {deleting ? "…" : checkedStrategyIds.size > 1 ? `Delete ${checkedStrategyIds.size}` : "Confirm"}
                    </button>
                    <button
                      onClick={() => setConfirming(false)}
                      disabled={deleting}
                      className="rounded border border-blue-700 px-1.5 py-0.5 text-[10px] text-blue-400 hover:bg-blue-900/30 transition-colors"
                    >
                      Cancel
                    </button>
                  </>
                ) : (
                  <button
                    disabled={checkedStrategyIds.size === 0 && !selectedStrategy}
                    onClick={() => setConfirming(true)}
                    title={checkedStrategyIds.size > 1 ? `Delete ${checkedStrategyIds.size} strategies` : "Delete strategy"}
                    className="flex items-center gap-1 rounded border border-red-800 p-0.5 text-red-400 hover:bg-red-900/30 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="3 6 5 6 21 6" />
                      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                      <path d="M10 11v6" />
                      <path d="M14 11v6" />
                      <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
                    </svg>
                    {checkedStrategyIds.size > 1 && (
                      <span className="text-[10px] font-mono">{checkedStrategyIds.size}</span>
                    )}
                  </button>
                )}
                <input
                  type="checkbox"
                  title="Select all"
                  checked={active.length > 0 && checkedStrategyIds.size === active.length}
                  ref={(el) => {
                    if (el) el.indeterminate = checkedStrategyIds.size > 0 && checkedStrategyIds.size < active.length;
                  }}
                  onChange={(e) => {
                    if (e.target.checked) setCheckedStrategyIds(new Set(active.map((s) => s.id)));
                    else setCheckedStrategyIds(new Set());
                  }}
                  className="h-3 w-3 accent-blue-500 cursor-pointer ml-0.5"
                />
              </div>
              {/* Sort bar */}
              <div className="flex items-center gap-1 flex-wrap">
                {(Object.keys(STRATEGY_SORT_LABELS) as StrategySortKey[]).map((k) => {
                  const active_ = strategySortKey === k;
                  return (
                    <button
                      key={k}
                      onClick={() => {
                        if (active_) setStrategySortDir((d) => d === "asc" ? "desc" : "asc");
                        else { setStrategySortKey(k); setStrategySortDir("asc"); }
                      }}
                      className={`text-[10px] px-1.5 py-0.5 rounded transition-colors ${active_ ? "bg-blue-700 text-white" : "text-gray-500 hover:text-gray-300"}`}
                    >
                      {STRATEGY_SORT_LABELS[k]}{active_ ? (strategySortDir === "asc" ? " ↑" : " ↓") : ""}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
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
              sortStrategies(active, strategySortKey, strategySortDir).map((s) => (
                <StrategyCard
                  key={s.id}
                  s={s}
                  selected={selectedStrategyId === s.id}
                  checked={checkedStrategyIds.has(s.id)}
                  showIR={showIR}
                  onSelect={handleSelectStrategy}
                  onCheck={(id, val) => setCheckedStrategyIds((prev) => {
                    const next = new Set(prev);
                    if (val) next.add(id); else next.delete(id);
                    return next;
                  })}
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
          <div className="px-4 py-4 border-b border-surface-border shrink-0 space-y-3">
            <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide">
              Backtests{checkedBacktestIds.size > 0 ? ` · ${checkedBacktestIds.size}` : ""}
            </p>
            {selectedStrategy && (
              <p className="text-xs text-gray-500 truncate">{selectedStrategy.description}</p>
            )}
            {/* Backtest action toolbar */}
            {(() => {
              const bt = backtests.find((b) => b.id === selectedBacktestId) ?? null;
              const deleteIds = checkedBacktestIds.size > 0 ? checkedBacktestIds : bt ? new Set([bt.id]) : new Set<string>();
              const canDelete = deleteIds.size > 0;
              const btnBase = "rounded border border-blue-700 px-1.5 py-0.5 text-[10px] text-blue-400 hover:bg-blue-900/30 transition-colors";
              const btnOff = "opacity-30 pointer-events-none";
              return (
                <div className="flex items-center gap-1 flex-nowrap">
                  <Link
                    href={bt ? `/superchart?strategy_id=${bt.strategy_id}&backtest_id=${bt.id}` : "#"}
                    onClick={(e) => { if (!bt) e.preventDefault(); }}
                    className={`${btnBase} ${!bt ? btnOff : ""}`}
                  >
                    Superchart
                  </Link>
                  <Link
                    href={bt ? `/backtest?strategy_id=${bt.strategy_id}&pair=${bt.pair}&timeframe=${bt.timeframe}&period_start=${bt.period_start.slice(0,10)}&period_end=${bt.period_end.slice(0,10)}` : "#"}
                    onClick={(e) => { if (!bt) e.preventDefault(); }}
                    className={`${btnBase} ${!bt ? btnOff : ""}`}
                  >
                    Backtest
                  </Link>
                  <Link
                    href={bt ? `/optimization?strategy_id=${bt.strategy_id}&pair=${bt.pair}&timeframe=${bt.timeframe}&period_start=${bt.period_start.slice(0,10)}&period_end=${bt.period_end.slice(0,10)}` : "#"}
                    onClick={(e) => { if (!bt) e.preventDefault(); }}
                    className={`${btnBase} ${!bt ? btnOff : ""}`}
                  >
                    Optimize
                  </Link>
                  <Link
                    href={bt ? `/copilot?strategy_id=${bt.strategy_id}` : "#"}
                    onClick={(e) => { if (!bt) e.preventDefault(); }}
                    className={`${btnBase} ${!bt ? btnOff : ""}`}
                  >
                    Refine
                  </Link>
                  <button
                    disabled={!canDelete}
                    title={deleteIds.size > 1 ? `Delete ${deleteIds.size} backtests` : "Delete backtest"}
                    onClick={async () => {
                      if (!canDelete) return;
                      await Promise.allSettled(
                        [...deleteIds].map((id) => fetchWithAuth(`${API_BASE}/api/backtest/results/${id}`, { method: "DELETE" }))
                      );
                      setBacktests((prev) => prev.filter((b) => !deleteIds.has(b.id)));
                      if (selectedBacktestId && deleteIds.has(selectedBacktestId)) setSelectedBacktestId(null);
                      setCheckedBacktestIds(new Set());
                    }}
                    className="flex items-center gap-1 rounded border border-red-800 p-0.5 text-red-400 hover:bg-red-900/30 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="3 6 5 6 21 6" />
                      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                      <path d="M10 11v6" />
                      <path d="M14 11v6" />
                      <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
                    </svg>
                    {deleteIds.size > 1 && (
                      <span className="text-[10px] font-mono">{deleteIds.size}</span>
                    )}
                  </button>
                  {backtests.length > 0 && (
                    <input
                      type="checkbox"
                      title="Select all"
                      checked={checkedBacktestIds.size === backtests.length}
                      ref={(el) => {
                        if (el) el.indeterminate = checkedBacktestIds.size > 0 && checkedBacktestIds.size < backtests.length;
                      }}
                      onChange={(e) => {
                        if (e.target.checked) setCheckedBacktestIds(new Set(backtests.map((b) => b.id)));
                        else setCheckedBacktestIds(new Set());
                      }}
                      className="h-3 w-3 accent-blue-500 cursor-pointer ml-0.5"
                    />
                  )}
                </div>
              );
            })()}
            {backtests.length > 1 && (
              <div className="flex items-center gap-1.5 flex-wrap">
                {(Object.keys(BACKTEST_SORT_LABELS) as BacktestSortKey[]).map((k) => {
                  const active_ = backtestSortKey === k;
                  return (
                    <button
                      key={k}
                      onClick={() => {
                        if (active_) setBacktestSortDir((d) => d === "asc" ? "desc" : "asc");
                        else { setBacktestSortKey(k); setBacktestSortDir("desc"); }
                      }}
                      className={`text-[10px] px-1 py-0.5 rounded transition-colors ${active_ ? "bg-blue-700 text-white" : "text-gray-500 hover:text-gray-300"}`}
                    >
                      {BACKTEST_SORT_LABELS[k]}{active_ ? (backtestSortDir === "asc" ? " ↑" : " ↓") : ""}
                    </button>
                  );
                })}
              </div>
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
            {!loadingBacktests && sortBacktests(backtests, backtestSortKey, backtestSortDir).map((r) => (
              <div
                key={r.id}
                onClick={() => setSelectedBacktestId(r.id === selectedBacktestId ? null : r.id)}
                className={[
                  "rounded-lg border px-3 py-2.5 cursor-pointer transition-colors",
                  selectedBacktestId === r.id
                    ? "border-accent bg-accent/10"
                    : checkedBacktestIds.has(r.id)
                    ? "border-blue-800 bg-blue-900/10"
                    : "border-surface-border hover:border-gray-600 hover:bg-surface-raised",
                ].join(" ")}
              >
                <div className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={checkedBacktestIds.has(r.id)}
                    onChange={(e) => {
                      e.stopPropagation();
                      setCheckedBacktestIds((prev) => {
                        const next = new Set(prev);
                        if (e.target.checked) next.add(r.id); else next.delete(r.id);
                        return next;
                      });
                    }}
                    onClick={(e) => e.stopPropagation()}
                    className="h-3 w-3 shrink-0 accent-blue-500 cursor-pointer"
                  />
                  <span className="text-xs font-medium text-gray-200">{r.pair}</span>
                  <span className="text-xs text-gray-500">{r.timeframe}</span>
                  <span className={`text-xs font-medium ml-auto ${r.total_pnl >= 0 ? "text-green-400" : "text-red-400"}`}>
                    {r.total_pnl >= 0 ? "+" : ""}${fmt(r.total_pnl, 0)}
                  </span>
                </div>
                <div className="flex items-center gap-2 mt-1 text-xs pl-5">
                  <span className="text-gray-400">Sh <span className="font-medium">{fmt(r.sharpe)}</span></span>
                  <span className="text-gray-400">WR <span className="font-medium">{fmtPct(r.win_rate)}</span></span>
                  <span className="text-gray-400">Tr <span className="font-medium">{r.trade_count ?? "—"}</span></span>
                </div>
                <div className="flex items-center justify-between mt-0.5 text-[10px] text-gray-600 pl-5">
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
