"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { fetchWithAuth } from "@/lib/auth";
import { conditionToLabel, exitConditionToLabel } from "@/lib/strategyLabels";
import type { GOptimizeRun, GOptimizeStrategy } from "@/lib/gOptimizeTypes";

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "";

// ---------------------------------------------------------------------------
// Action button bar — auto-promotes to RAG if needed, then navigates
// ---------------------------------------------------------------------------
function ActionButtons({ item, run, onPromoted }: {
  item:       GOptimizeStrategy;
  run:        GOptimizeRun | null;
  onPromoted: (btRunId: string, strategyId: string) => void;
}) {
  const router    = useRouter();
  const [busy, setBusy] = useState(false);

  const pair      = item.pair;
  const timeframe = run?.timeframe ?? "";
  const start     = run?.period_start?.slice(0, 10) ?? "";
  const end       = run?.period_end?.slice(0, 10)   ?? "";
  const btid      = item.backtest_run_id;

  const btnCls     = "rounded border border-blue-700 px-1.5 py-0.5 text-[10px] text-blue-400 hover:bg-blue-900/30 transition-colors whitespace-nowrap disabled:opacity-40 disabled:cursor-not-allowed";
  const labBtnCls  = "rounded border border-blue-700 px-1.5 py-0.5 text-[10px] text-blue-400 hover:bg-blue-900/30 transition-colors whitespace-nowrap";

  async function resolveStrategyId(): Promise<string | null> {
    if (item.strategy_id) return item.strategy_id;
    setBusy(true);
    try {
      const res = await fetchWithAuth(
        `${API_BASE}/api/g-optimize/strategies/${btid}/promote`,
        { method: "POST" },
      );
      if (!res.ok) return null;
      const data = await res.json();
      const sid: string = data.strategy_id;
      onPromoted(btid, sid);
      return sid;
    } catch {
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function go(buildHref: (sid: string) => string) {
    const sid = await resolveStrategyId();
    if (sid) router.push(buildHref(sid));
  }

  return (
    <div className="flex flex-wrap gap-1.5 pt-1">
      <button disabled={busy} onClick={() => go((sid) => `/superchart?strategy_id=${sid}&backtest_id=${btid}`)} className={btnCls}>
        {busy ? "…" : "Superchart →"}
      </button>
      <button disabled={busy} onClick={() => go((sid) => `/backtest?strategy_id=${sid}&pair=${pair}&timeframe=${timeframe}&period_start=${start}&period_end=${end}`)} className={btnCls}>
        {busy ? "…" : "Backtest →"}
      </button>
      <button disabled={busy} onClick={() => go((sid) => `/optimization?strategy_id=${sid}&pair=${pair}&timeframe=${timeframe}&period_start=${start}&period_end=${end}`)} className={btnCls}>
        {busy ? "…" : "Optimize →"}
      </button>
      <button disabled={busy} onClick={() => go((sid) => `/copilot?strategy_id=${sid}&pair=${pair}&timeframe=${timeframe}&backtest_id=${btid}`)} className={btnCls}>
        {busy ? "…" : "Refine →"}
      </button>
      <Link href={`/lab?pair=${pair}&timeframe=${timeframe}`} className={labBtnCls}>
        Open in Lab →
      </Link>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function fmt(v: number | null | undefined, d = 2): string {
  return v == null ? "—" : v.toFixed(d);
}
function fmtPct(v: number | null | undefined): string {
  return v == null ? "—" : (v * 100).toFixed(1) + "%";
}

function shortIr(ir: Record<string, unknown>): string {
  const conds = ir.entry_conditions as Record<string, unknown>[] | undefined;
  if (!conds?.length) return "—";
  return conds
    .slice(0, 2)
    .map((c) => {
      const ind = String(c.indicator ?? "");
      const period = c.period != null ? `(${c.period})` : "";
      return `${ind}${period}`;
    })
    .join(" + ") + (conds.length > 2 ? ` +${conds.length - 2}` : "");
}

function RagBadge({ status }: { status: string }) {
  if (status === "in_rag")
    return <span className="text-[9px] text-green-400 border border-green-800 rounded px-1">In RAG</span>;
  if (status === "pending")
    return <span className="text-[9px] text-yellow-400 border border-yellow-800 rounded px-1">Pending</span>;
  return null;
}

type SortKey = "sharpe" | "win_rate" | "max_dd" | "trades";

// ---------------------------------------------------------------------------
// Inline detail row
// ---------------------------------------------------------------------------
function DetailRow({ item, run, onPromoted }: { item: GOptimizeStrategy; run: GOptimizeRun | null; onPromoted: (btRunId: string, sid: string) => void }) {
  const ir    = item.ir ?? {};
  const entry = (ir.entry_conditions as Record<string, unknown>[] | undefined) ?? [];
  const exits = ir.exit_conditions as Record<string, unknown> | undefined;
  const sl    = exits?.stop_loss    as Record<string, unknown> | undefined;
  const tp    = exits?.take_profit  as Record<string, unknown> | undefined;

  return (
    <tr className="bg-zinc-900/60">
      <td colSpan={9} className="px-4 py-3">
        <div className="space-y-2 text-[11px]">
          {/* Entry conditions */}
          <div>
            <span className="text-zinc-500 uppercase text-[9px] tracking-wide">Entry</span>
            <div className="mt-0.5 space-y-0.5">
              {entry.map((c, i) => (
                <div key={i} className="text-zinc-300">
                  {conditionToLabel(c as unknown as Parameters<typeof conditionToLabel>[0])}
                </div>
              ))}
            </div>
          </div>

          {/* Exit conditions */}
          {(sl || tp) && (
            <div className="flex gap-6">
              {sl && (
                <div>
                  <span className="text-zinc-500 uppercase text-[9px] tracking-wide">SL</span>
                  <div className="text-zinc-300 mt-0.5">
                    {exitConditionToLabel("Stop Loss", sl as unknown as Parameters<typeof exitConditionToLabel>[1])}
                  </div>
                </div>
              )}
              {tp && (
                <div>
                  <span className="text-zinc-500 uppercase text-[9px] tracking-wide">TP</span>
                  <div className="text-zinc-300 mt-0.5">
                    {exitConditionToLabel("Take Profit", tp as unknown as Parameters<typeof exitConditionToLabel>[1])}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Metrics row */}
          <div className="flex gap-4 text-zinc-400 text-[10px] border-t border-zinc-700/50 pt-2">
            <span>Sharpe <strong className="text-zinc-200">{fmt(item.sharpe)}</strong></span>
            <span>WR <strong className="text-zinc-200">{fmtPct(item.win_rate)}</strong></span>
            <span>MaxDD <strong className="text-zinc-200">{fmtPct(item.max_dd)}</strong></span>
            <span>Trades <strong className="text-zinc-200">{item.trade_count ?? "—"}</strong></span>
          </div>

          {/* Action buttons */}
          <ActionButtons item={item} run={run} onPromoted={onPromoted} />
        </div>
      </td>
    </tr>
  );
}

// ---------------------------------------------------------------------------
// Near-miss detection
// ---------------------------------------------------------------------------
function isNearMiss(item: GOptimizeStrategy, run: GOptimizeRun | null): boolean {
  if (!run || item.passed_threshold) return false;
  const margin = 0.9; // within 10%
  const sharpeOk  = item.sharpe   != null && item.sharpe   >= (run.threshold_sharpe   ?? 0) * margin;
  const wrOk      = item.win_rate  != null && item.win_rate * 100 >= (run.threshold_win_rate  ?? 0) * margin;
  const ddOk      = item.max_dd    != null && Math.abs(item.max_dd) * 100 <= (run.threshold_max_dd ?? 100) * (2 - margin);
  return sharpeOk || wrOk || ddOk;
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------
interface Props {
  targetRunIds: string[];              // run IDs whose strategies to display
  runs:         GOptimizeRun[];        // all runs (for section headers + thresholds)
  checkedIds:   Set<string>;
  onCheck:      (id: string, checked: boolean) => void;
  onClearAll:   () => void;
}

interface StrategiesPage {
  items:    GOptimizeStrategy[];
  total:    number;
  page:     number;
  per_page: number;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------
export default function GOptimizeStrategies({
  targetRunIds, runs, checkedIds, onCheck, onClearAll,
}: Props) {
  const [tab,        setTab]        = useState<"passed" | "failed">("passed");
  const [sort,       setSort]       = useState<SortKey>("sharpe");
  const [page,       setPage]       = useState(1);
  const [data,       setData]       = useState<StrategiesPage | null>(null);
  const [loading,    setLoading]    = useState(false);
  const [expanded,   setExpanded]   = useState<Set<string>>(new Set());
  const [promoting,  setPromoting]  = useState<Record<string, boolean>>({});
  const [ragOverrides,      setRagOverrides]      = useState<Record<string, string>>({});
  const [strategyIdCache,   setStrategyIdCache]   = useState<Record<string, string>>({});

  const selectAllRef = useRef<HTMLInputElement>(null);
  const multiRun     = targetRunIds.length > 1;

  // Counts per tab (from the runs themselves for quick display)
  const passedCount = runs
    .filter((r) => targetRunIds.includes(r.id))
    .reduce((s, r) => s + r.configs_passed, 0);
  const failedCount = runs
    .filter((r) => targetRunIds.includes(r.id))
    .reduce((s, r) => s + r.configs_failed, 0);

  // Primary run (first in targetRunIds) for threshold-based near-miss
  const primaryRun = runs.find((r) => r.id === targetRunIds[0]) ?? null;

  const load = useCallback(async () => {
    if (!targetRunIds.length) return;
    setLoading(true);
    try {
      const [primary, ...extra] = targetRunIds;
      const extraParams = extra.map((id) => `&run_ids=${encodeURIComponent(id)}`).join("");
      const url = `${API_BASE}/api/g-optimize/runs/${primary}/strategies?tab=${tab}&sort=${sort}&page=${page}&per_page=50${extraParams}`;
      const res = await fetchWithAuth(url);
      if (res.ok) setData(await res.json());
    } catch { /* non-fatal */ }
    finally { setLoading(false); }
  }, [targetRunIds, tab, sort, page]);

  useEffect(() => { setPage(1); }, [targetRunIds, tab, sort]);
  useEffect(() => { load(); }, [load]);

  // Select-all indeterminate state
  useEffect(() => {
    if (!selectAllRef.current || !data) return;
    const pageIds  = data.items.map((i) => i.backtest_run_id);
    const checked  = pageIds.filter((id) => checkedIds.has(id));
    selectAllRef.current.indeterminate = checked.length > 0 && checked.length < pageIds.length;
    selectAllRef.current.checked       = checked.length === pageIds.length && pageIds.length > 0;
  }, [checkedIds, data]);

  function toggleSelectAll() {
    if (!data) return;
    const pageIds = data.items.map((i) => i.backtest_run_id);
    const allChecked = pageIds.every((id) => checkedIds.has(id));
    pageIds.forEach((id) => onCheck(id, !allChecked));
  }

  function toggleExpand(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) { next.delete(id); } else { next.add(id); }
      return next;
    });
  }

  function handleSort(key: SortKey) {
    setSort(key);
  }

  async function handlePromote(btRunId: string) {
    setPromoting((prev) => ({ ...prev, [btRunId]: true }));
    try {
      const [primary] = targetRunIds;
      // The promote endpoint is keyed by backtest_run_id but needs the run context for auth
      const res = await fetchWithAuth(
        `${API_BASE}/api/g-optimize/strategies/${btRunId}/promote`,
        { method: "POST" },
      );
      if (res.ok) {
        setRagOverrides((prev) => ({ ...prev, [btRunId]: "in_rag" }));
      }
      void primary; // suppress unused var — kept for future scope-narrowing
    } catch { /* non-fatal */ }
    finally {
      setPromoting((prev) => ({ ...prev, [btRunId]: false }));
    }
  }

  function SortTh({ col, label }: { col: SortKey; label: string }) {
    const active = sort === col;
    return (
      <th
        className={`px-3 py-1.5 text-right cursor-pointer select-none whitespace-nowrap ${active ? "text-blue-400" : "text-zinc-500 hover:text-zinc-300"}`}
        onClick={() => handleSort(col)}
      >
        {label}{active ? " ↓" : ""}
      </th>
    );
  }

  if (!targetRunIds.length) {
    return (
      <div className="flex-1 flex items-center justify-center text-[11px] text-zinc-600">
        Select a run to view its strategies.
      </div>
    );
  }

  const items     = data?.items ?? [];
  const totalPages = data ? Math.ceil(data.total / data.per_page) : 1;

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-zinc-800 shrink-0">
        {/* Tabs */}
        <button
          onClick={() => setTab("passed")}
          className={`text-[10px] px-2 py-0.5 rounded border transition-colors ${
            tab === "passed"
              ? "border-green-700 text-green-400 bg-green-900/20"
              : "border-zinc-700 text-zinc-500 hover:text-zinc-300"
          }`}
        >
          Passed ✓ {passedCount.toLocaleString()}
        </button>
        <button
          onClick={() => setTab("failed")}
          className={`text-[10px] px-2 py-0.5 rounded border transition-colors ${
            tab === "failed"
              ? "border-red-800 text-red-400 bg-red-900/20"
              : "border-zinc-700 text-zinc-500 hover:text-zinc-300"
          }`}
        >
          Failed ✗ {failedCount.toLocaleString()}
        </button>

        <div className="ml-auto flex items-center gap-2">
          {checkedIds.size > 0 && (
            <button onClick={onClearAll} className="text-[10px] text-zinc-500 hover:text-zinc-300 transition-colors">
              Clear ({checkedIds.size})
            </button>
          )}
          {loading && <span className="text-[10px] text-zinc-600">Loading…</span>}
        </div>
      </div>

      {/* Table */}
      <div className="flex-1 overflow-auto">
        <table className="w-full text-xs border-collapse">
          <thead className="sticky top-0 bg-zinc-900 z-10">
            <tr className="border-b border-zinc-700">
              <th className="px-2 py-1.5 w-6">
                <input
                  ref={selectAllRef}
                  type="checkbox"
                  className="h-3 w-3 accent-blue-500 cursor-pointer"
                  onChange={toggleSelectAll}
                />
              </th>
              <th className="px-3 py-1.5 text-left text-zinc-500">Pair</th>
              <th className="px-3 py-1.5 text-left text-zinc-500">Indicators</th>
              <SortTh col="sharpe"   label="Sharpe" />
              <SortTh col="win_rate" label="WR" />
              <SortTh col="max_dd"   label="MaxDD" />
              <SortTh col="trades"   label="Trades" />
              <th className="px-3 py-1.5 text-left text-zinc-500">RAG</th>
              <th className="px-2 py-1.5 w-6" />
            </tr>
          </thead>
          <tbody>
            {items.map((item, i) => {
              const isChecked  = checkedIds.has(item.backtest_run_id);
              const isExpanded = expanded.has(item.backtest_run_id);
              const nearMiss   = isNearMiss(item, primaryRun);
              const ragStatus  = ragOverrides[item.backtest_run_id] ?? item.rag_status;
              const isPromoting = !!promoting[item.backtest_run_id];
              const canPromote = tab === "failed" && ragStatus !== "in_rag";

              // Section header for multi-run view
              const showHeader =
                multiRun &&
                (i === 0 || items[i - 1].run_id !== item.run_id);

              const runForHeader = runs.find((r) => r.id === item.run_id);
              const runIdx       = runs.findIndex((r) => r.id === item.run_id);
              const runNumber    = runs.length - runIdx;

              return (
                <>
                  {showHeader && (
                    <tr key={`hdr-${item.run_id}`} className="bg-zinc-800/40">
                      <td colSpan={9} className="px-3 py-1 text-[10px] text-zinc-400 font-medium border-b border-zinc-700/60">
                        Run #{runNumber} — {runForHeader?.pairs.join(" + ") ?? ""} · {runForHeader?.timeframe}
                      </td>
                    </tr>
                  )}

                  <tr
                    key={item.backtest_run_id}
                    onClick={() => toggleExpand(item.backtest_run_id)}
                    className={[
                      "border-b border-zinc-800/60 transition-colors cursor-pointer",
                      isChecked
                        ? "bg-blue-900/10 border-l-2 border-l-blue-800"
                        : nearMiss
                        ? "border-l-2 border-l-yellow-700/60"
                        : "hover:bg-zinc-800/30",
                    ].join(" ")}
                  >
                    <td className="px-2 py-1.5 text-center" onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        checked={isChecked}
                        onChange={(e) => onCheck(item.backtest_run_id, e.target.checked)}
                        className="h-3 w-3 accent-blue-500 cursor-pointer"
                      />
                    </td>
                    <td className="px-3 py-1.5 text-zinc-300 font-medium">{item.pair}</td>
                    <td className="px-3 py-1.5 text-zinc-400 max-w-[200px] truncate">
                      {shortIr(item.ir)}
                    </td>
                    <td className={`px-3 py-1.5 text-right font-medium ${(item.sharpe ?? 0) >= 1 ? "text-green-400" : (item.sharpe ?? 0) >= 0.5 ? "text-yellow-400" : "text-zinc-300"}`}>
                      {fmt(item.sharpe)}
                    </td>
                    <td className="px-3 py-1.5 text-right text-zinc-300">{fmtPct(item.win_rate)}</td>
                    <td className="px-3 py-1.5 text-right text-zinc-300">{fmtPct(item.max_dd)}</td>
                    <td className="px-3 py-1.5 text-right text-zinc-400">{item.trade_count ?? "—"}</td>
                    <td className="px-3 py-1.5" onClick={(e) => e.stopPropagation()}>
                      {canPromote ? (
                        <button
                          onClick={() => handlePromote(item.backtest_run_id)}
                          disabled={isPromoting}
                          className="rounded border border-zinc-600 px-1.5 py-0.5 text-[9px] text-zinc-400 hover:border-blue-700 hover:text-blue-400 disabled:opacity-40 transition-colors whitespace-nowrap"
                        >
                          {isPromoting ? "Promoting…" : "Promote to RAG"}
                        </button>
                      ) : (
                        <RagBadge status={ragStatus} />
                      )}
                    </td>
                    <td className="px-2 py-1.5 text-center text-zinc-500 text-[10px]">
                      {isExpanded ? "▾" : "▸"}
                    </td>
                  </tr>

                  {isExpanded && (
                    <DetailRow
                      key={`det-${item.backtest_run_id}`}
                      item={{ ...item, strategy_id: strategyIdCache[item.backtest_run_id] ?? item.strategy_id }}
                      run={runs.find((r) => r.id === item.run_id) ?? null}
                      onPromoted={(btRunId, sid) => {
                        setRagOverrides((prev) => ({ ...prev, [btRunId]: "in_rag" }));
                        setStrategyIdCache((prev) => ({ ...prev, [btRunId]: sid }));
                      }}
                    />
                  )}
                </>
              );
            })}

            {!loading && items.length === 0 && (
              <tr>
                <td colSpan={9} className="px-4 py-8 text-center text-[11px] text-zinc-600">
                  No {tab} strategies for this run yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between px-3 py-2 border-t border-zinc-800 shrink-0">
          <button
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page <= 1}
            className="text-[10px] text-zinc-400 disabled:opacity-30 hover:text-zinc-200 transition-colors"
          >
            ← Prev
          </button>
          <span className="text-[10px] text-zinc-500">
            Page {page} / {totalPages}
            {data && <span className="text-zinc-600 ml-2">({data.total.toLocaleString()} total)</span>}
          </span>
          <button
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            disabled={page >= totalPages}
            className="text-[10px] text-zinc-400 disabled:opacity-30 hover:text-zinc-200 transition-colors"
          >
            Next →
          </button>
        </div>
      )}
    </div>
  );
}
