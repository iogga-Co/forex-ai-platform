"use client";

import Link from "next/link";
import { FormEvent, Suspense, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { fetchWithAuth } from "@/lib/auth";
import BacktestResultPanel from "@/components/BacktestResultPanel";
import DiagnosisSidebar from "@/components/DiagnosisSidebar";
import { loadSettings } from "@/lib/settings";
import type { StrategyIR } from "@/lib/irPatch";
import Spinbox from "@/components/Spinbox";

interface Strategy {
  id: string;
  version: number;
  description: string;
  pair: string;
  timeframe: string;
  ir_json: StrategyIR;
}

interface JobStatus {
  status: string;
  progress_pct: number;
  result_id: string | null;
  error: string | null;
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

const PAIRS = ["EURUSD", "GBPUSD", "USDJPY", "EURGBP", "GBPJPY", "USDCHF"];
const TIMEFRAMES = ["1m", "5m", "15m", "30m", "1H", "4H", "1D"];

interface ParamDef { key: string; label: string; step: number; min: number; max?: number; isInt?: boolean }

function getConditionParams(cond: Record<string, unknown>): ParamDef[] {
  switch (cond.indicator as string) {
    case "MACD": return [
      { key: "fast",          label: "fast", step: 1, min: 1, max: 50,  isInt: true },
      { key: "slow",          label: "slow", step: 1, min: 5, max: 100, isInt: true },
      { key: "signal_period", label: "sig",  step: 1, min: 1, max: 50,  isInt: true },
    ];
    case "BB": return [
      { key: "period",  label: "period", step: 1,   min: 5,   max: 100, isInt: true },
      { key: "std_dev", label: "σ",      step: 0.1, min: 0.5, max: 5.0 },
    ];
    case "STOCH": return [
      { key: "period",   label: "K",   step: 1, min: 1, max: 100, isInt: true },
      { key: "k_smooth", label: "Ksm", step: 1, min: 1, max: 50,  isInt: true },
      { key: "d_period", label: "D",   step: 1, min: 1, max: 50,  isInt: true },
    ];
    default: {
      const ind = (cond.indicator as string)?.toUpperCase();
      const max = (ind === "EMA" || ind === "SMA") ? 999 : 100;
      const min = (ind === "RSI" || ind === "ATR") ? 2 : 1;
      const params: ParamDef[] = [{ key: "period", label: "period", step: 1, min, max, isInt: true }];
      if ("value" in cond) params.push({ key: "value", label: "val", step: 0.1, min: 0 });
      return params;
    }
  }
}

function getExitParams(cond: Record<string, unknown>): ParamDef[] {
  if (cond.type === "atr") return [
    { key: "period",     label: "period", step: 1,   min: 2,   max: 100, isInt: true },
    { key: "multiplier", label: "mult",   step: 0.1, min: 0.5, max: 10.0 },
  ];
  return [{ key: "value", label: cond.type === "pct" ? "%" : "pips", step: cond.type === "pct" ? 0.1 : 1, min: 0.1 }];
}

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

type SortKey = "created_at" | "sharpe" | "win_rate" | "trade_count" | "total_pnl";
type SortDir = "asc" | "desc";

const SORT_LABELS: Record<SortKey, string> = {
  created_at: "Date",
  sharpe: "Sharpe",
  win_rate: "Win %",
  trade_count: "Trades",
  total_pnl: "PnL",
};

function sortRuns(runs: RunSummary[], key: SortKey, dir: SortDir): RunSummary[] {
  return [...runs].sort((a, b) => {
    const av = a[key] ?? (dir === "desc" ? -Infinity : Infinity);
    const bv = b[key] ?? (dir === "desc" ? -Infinity : Infinity);
    const cmp = av < bv ? -1 : av > bv ? 1 : 0;
    return dir === "asc" ? cmp : -cmp;
  });
}

export default function BacktestPage() {
  return (
    <Suspense>
      <BacktestPageInner />
    </Suspense>
  );
}

function BacktestPageInner() {
  const searchParams = useSearchParams();
  const [strategies, setStrategies] = useState<Strategy[]>([]);
  const [history, setHistory] = useState<RunSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [checkedIds, setCheckedIds] = useState<Set<string>>(new Set());
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>("created_at");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  const cfg = loadSettings();
  const [form, setForm] = useState({
    strategy_id: searchParams.get("strategy_id") ?? "",
    pair: searchParams.get("pair") ?? cfg.default_pair,
    timeframe: searchParams.get("timeframe") ?? cfg.default_timeframe,
    period_start: searchParams.get("period_start") ?? cfg.default_period_start,
    period_end: searchParams.get("period_end") ?? cfg.default_period_end,
    initial_capital: String(cfg.default_initial_capital),
  });
  const [editedIr, setEditedIr] = useState<Record<string, unknown> | null>(null);
  const [irDirty, setIrDirty] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const [jobStatus, setJobStatus] = useState<JobStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notLoggedIn, setNotLoggedIn] = useState(false);
  const [diagnosisOpen, setDiagnosisOpen] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!localStorage.getItem("access_token")) {
      setNotLoggedIn(true);
      return;
    }

    function loadStrategies() {
      Promise.all([
        fetchWithAuth("/api/strategies").then((r) => r.json()),
        fetchWithAuth("/api/strategies/deleted").then((r) => r.ok ? r.json() : []),
      ])
        .then(([active, deleted]) => {
          const activeList: Strategy[] = Array.isArray(active) ? active : active.strategies ?? [];
          const deletedList: Strategy[] = Array.isArray(deleted) ? deleted : [];
          const list = [...activeList, ...deletedList];
          setStrategies(list);
          setForm((f) => {
            if (f.strategy_id && activeList.some((s) => s.id === f.strategy_id)) return f;
            return { ...f, strategy_id: activeList[0]?.id ?? "" };
          });
        })
        .catch(() => {});
    }

    loadStrategies();

    const { backtest_history_limit } = loadSettings();
    fetchWithAuth(`/api/backtest/results?limit=${backtest_history_limit}`)
      .then((r) => r.json())
      .then((data: RunSummary[]) => setHistory(Array.isArray(data) ? data : []))
      .catch(() => {});

    const onVisible = () => { if (document.visibilityState === "visible") loadStrategies(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);

  // Sync editedIr when strategy selection changes
  useEffect(() => {
    const strat = strategies.find((s) => s.id === form.strategy_id);
    if (strat?.ir_json) {
      const ir = strat.ir_json;
      setEditedIr(typeof ir === "string" ? JSON.parse(ir) : { ...(ir as Record<string, unknown>) });
      setIrDirty(false);
    } else {
      setEditedIr(null);
    }
  }, [form.strategy_id, strategies]);

  function updateEntryParam(idx: number, key: string, value: number) {
    setEditedIr((prev) => {
      if (!prev) return prev;
      const conditions = [...(prev.entry_conditions as Record<string, unknown>[])];
      conditions[idx] = { ...conditions[idx], [key]: value };
      return { ...prev, entry_conditions: conditions };
    });
    setIrDirty(true);
  }

  function updateExitParam(side: "stop_loss" | "take_profit", key: string, value: number) {
    setEditedIr((prev) => {
      if (!prev) return prev;
      const exitConds = prev.exit_conditions as Record<string, Record<string, unknown>>;
      return { ...prev, exit_conditions: { ...exitConds, [side]: { ...exitConds[side], [key]: value } } };
    });
    setIrDirty(true);
  }

  function updateSizingParam(key: string, value: number) {
    setEditedIr((prev) => {
      if (!prev) return prev;
      const sizing = prev.position_sizing as Record<string, unknown>;
      return { ...prev, position_sizing: { ...sizing, [key]: value } };
    });
    setIrDirty(true);
  }

  // Poll job status
  useEffect(() => {
    if (!jobId) return;
    pollRef.current = setInterval(async () => {
      try {
        const res = await fetchWithAuth(`/api/backtest/jobs/${jobId}/status`);
        const data: JobStatus = await res.json();
        setJobStatus(data);
        if (data.status === "complete" && data.result_id) {
          clearInterval(pollRef.current!);
          setJobId(null);
          // Add to history and open in panel
          fetchWithAuth(`/api/backtest/results?limit=${loadSettings().backtest_history_limit}`)
            .then((r) => r.json())
            .then((d: RunSummary[]) => setHistory(Array.isArray(d) ? d : []))
            .catch(() => {});
          setSelectedId(data.result_id);
        }
        if (data.status === "failed") {
          clearInterval(pollRef.current!);
          setError(data.error ?? "Backtest failed");
        }
      } catch {
        clearInterval(pollRef.current!);
      }
    }, 2000);
    return () => clearInterval(pollRef.current!);
  }, [jobId]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setJobId(null);
    setJobStatus(null);

    let strategyId = form.strategy_id;

    if (irDirty && editedIr) {
      const strat = strategies.find((s) => s.id === form.strategy_id);
      const name = `[BT seed] ${strat?.pair || form.pair} ${strat?.timeframe || form.timeframe}`;
      try {
        const saveRes = await fetchWithAuth("/api/strategies", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ir_json: editedIr,
            description: name,
            pair: strat?.pair || form.pair,
            timeframe: strat?.timeframe || form.timeframe,
          }),
        });
        if (!saveRes.ok) throw new Error(await saveRes.text());
        const saved = await saveRes.json();
        strategyId = saved.id;
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to save modified strategy");
        return;
      }
    }

    const sessionId = crypto.randomUUID();
    try {
      const res = await fetchWithAuth(`/api/backtest?session_id=${sessionId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          strategy_id: strategyId,
          pair: form.pair,
          timeframe: form.timeframe,
          period_start: form.period_start,
          period_end: form.period_end,
          initial_capital: parseFloat(form.initial_capital),
        }),
      });
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      setJobId(data.job_id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start backtest");
    }
  }

  const stratName = (s: Strategy) =>
    s.description || (s.ir_json?.metadata?.description as string | undefined)?.slice(0, 40) || s.id.slice(0, 8);

  if (notLoggedIn) {
    return (
      <div className="max-w-2xl space-y-4">
        <h1 className="text-xl font-semibold text-gray-100">Backtest</h1>
        <p className="text-sm text-gray-400">
          You need to{" "}
          <Link href="/login" className="text-blue-400 hover:underline">sign in</Link>{" "}
          to run backtests.
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full gap-0 overflow-hidden">

      {/* ── Left panel: form + history ── */}
      <div className="w-80 shrink-0 flex flex-col overflow-y-auto pr-6 border-r border-gray-800">

        {/* Form */}
        <div className="pb-4">
          <h1 className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide mb-1">Backtest</h1>

          <form onSubmit={handleSubmit} className="space-y-0.5">
            <div>
              <label className="text-[10px] text-gray-500 leading-none">Strategy</label>
              {strategies.length === 0 ? (
                <p className="text-xs text-gray-500">
                  No strategies yet —{" "}
                  <Link href="/copilot" className="text-blue-400 hover:underline">create one in Co-Pilot</Link>
                </p>
              ) : (
                <select
                  value={form.strategy_id}
                  onChange={(e) => setForm({ ...form, strategy_id: e.target.value })}
                  className="w-full bg-gray-800 border border-gray-700 text-gray-100 text-xs rounded px-2 py-0.5"
                >
                  {strategies.map((s) => (
                    <option key={s.id} value={s.id}>{stratName(s)}</option>
                  ))}
                </select>
              )}
            </div>

            {/* Indicator Parameters */}
            {editedIr && (() => {
              const entryConds = (editedIr.entry_conditions as Record<string, unknown>[]) ?? [];
              const exitConds  = editedIr.exit_conditions as Record<string, Record<string, unknown>> | undefined;
              const sizing     = editedIr.position_sizing as Record<string, unknown> | undefined;
              return (
                <div className="rounded border border-zinc-700 bg-zinc-800/50 p-2 space-y-1.5">
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] font-semibold text-zinc-400 uppercase tracking-wide">Indicator Parameters</span>
                    {irDirty && (
                      <span className="text-[10px] text-yellow-400 flex items-center gap-1">
                        ● modified
                        <button type="button" onClick={() => {
                          const s = strategies.find((s) => s.id === form.strategy_id);
                          if (s) { setEditedIr(JSON.parse(JSON.stringify(s.ir_json))); setIrDirty(false); }
                        }} className="text-zinc-500 hover:text-zinc-300 underline ml-1">reset</button>
                      </span>
                    )}
                  </div>
                  {entryConds.map((cond, idx) => (
                    <div key={idx} className="flex items-center gap-1.5 flex-wrap">
                      <span className="text-[10px] text-zinc-300 w-10 shrink-0">{String(cond.indicator)}</span>
                      {getConditionParams(cond).map((p) => (
                        <label key={p.key} className="flex items-center gap-0.5">
                          <span className="text-[10px] text-zinc-500">{p.label}</span>
                          <Spinbox step={p.step} min={p.min} max={p.max} value={Number(cond[p.key] ?? 0)}
                            onChange={(v) => updateEntryParam(idx, p.key, v)}
                            float={!p.isInt} width="w-16" />
                        </label>
                      ))}
                    </div>
                  ))}
                  {(["stop_loss", "take_profit"] as const).map((side) => {
                    const ec = exitConds?.[side];
                    if (!ec) return null;
                    return (
                      <div key={side} className="flex items-center gap-1.5 flex-wrap">
                        <span className="text-[10px] text-zinc-300 w-10 shrink-0">{side === "stop_loss" ? "SL" : "TP"}</span>
                        <span className="text-[10px] text-zinc-500">{String(ec.type)}</span>
                        {getExitParams(ec).map((p) => (
                          <label key={p.key} className="flex items-center gap-0.5">
                            <span className="text-[10px] text-zinc-500">{p.label}</span>
                            <Spinbox step={p.step} min={p.min} max={p.max} value={Number(ec[p.key] ?? 0)}
                              onChange={(v) => updateExitParam(side, p.key, v)}
                              float={!p.isInt} width="w-16" />
                          </label>
                        ))}
                      </div>
                    );
                  })}
                  {sizing && (
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="text-[10px] text-zinc-300 w-10 shrink-0">Size</span>
                      <label className="flex items-center gap-0.5">
                        <span className="text-[10px] text-zinc-500">risk%</span>
                        <Spinbox step={0.1} min={0.1} value={Number(sizing.risk_per_trade_pct ?? 1)}
                          onChange={(v) => updateSizingParam("risk_per_trade_pct", v)} float width="w-16" />
                      </label>
                      <label className="flex items-center gap-0.5">
                        <span className="text-[10px] text-zinc-500">max</span>
                        <Spinbox step={1000} min={1000} value={Number(sizing.max_size_units ?? 100000)}
                          onChange={(v) => updateSizingParam("max_size_units", v)} width="w-20" />
                      </label>
                    </div>
                  )}
                </div>
              );
            })()}

            {/* Pair · TF · From · To · Capital — 2×3 grid */}
            <div className="grid grid-cols-2 gap-x-2 gap-y-0.5">
              <div>
                <label className="text-[10px] text-gray-500 leading-none">Pair</label>
                <select value={form.pair} onChange={(e) => setForm({ ...form, pair: e.target.value })}
                  className="w-full bg-gray-800 border border-gray-700 text-gray-100 text-xs rounded px-2 py-0.5">
                  {PAIRS.map((p) => <option key={p}>{p}</option>)}
                </select>
              </div>
              <div>
                <label className="text-[10px] text-gray-500 leading-none">Timeframe</label>
                <select value={form.timeframe} onChange={(e) => setForm({ ...form, timeframe: e.target.value })}
                  className="w-full bg-gray-800 border border-gray-700 text-gray-100 text-xs rounded px-2 py-0.5">
                  {TIMEFRAMES.map((t) => <option key={t}>{t}</option>)}
                </select>
              </div>
              <div>
                <label className="text-[10px] text-gray-500 leading-none">From</label>
                <input type="date" value={form.period_start} onChange={(e) => setForm({ ...form, period_start: e.target.value })}
                  className="w-full bg-gray-800 border border-gray-700 text-gray-100 text-xs rounded px-2 py-0.5" />
              </div>
              <div>
                <label className="text-[10px] text-gray-500 leading-none">To</label>
                <input type="date" value={form.period_end} onChange={(e) => setForm({ ...form, period_end: e.target.value })}
                  className="w-full bg-gray-800 border border-gray-700 text-gray-100 text-xs rounded px-2 py-0.5" />
              </div>
              <div className="col-span-2">
                <label className="text-[10px] text-gray-500 leading-none">Initial capital ($)</label>
                <input type="number" value={form.initial_capital} onChange={(e) => setForm({ ...form, initial_capital: e.target.value })}
                  className="w-full bg-gray-800 border border-gray-700 text-gray-100 text-xs rounded px-2 py-0.5" />
              </div>
            </div>

            <button
              type="submit"
              disabled={!form.strategy_id || !!jobId}
              className="w-full bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-xs font-medium rounded px-3 py-1 transition-colors"
            >
              {jobId ? "Running…" : "Run Backtest"}
            </button>
          </form>

          {jobStatus && jobStatus.status !== "complete" && (
            <div className="space-y-1">
              <div className="flex justify-between text-xs text-gray-400">
                <span className="capitalize">{jobStatus.status}</span>
                <span>{jobStatus.progress_pct}%</span>
              </div>
              <div className="h-1.5 bg-gray-800 rounded">
                <div
                  className="h-1.5 bg-blue-500 rounded transition-all"
                  style={{ width: `${jobStatus.progress_pct}%` }}
                />
              </div>
            </div>
          )}

          {error && (
            <p className="text-sm text-red-400 bg-red-900/20 border border-red-800 rounded px-3 py-2">
              {error}
            </p>
          )}
        </div>

        {/* History */}
        <div className="space-y-2 flex-1">
          {/* Toolbar */}
          {(() => {
            const sel = history.find((r) => r.id === selectedId) ?? null;
            const btnBase = "rounded border border-blue-700 px-1.5 py-0.5 text-[10px] text-blue-400 hover:bg-blue-900/30 transition-colors";
            const btnOff = "opacity-30 pointer-events-none";
            return (
              <div className="flex items-center gap-1 flex-nowrap">
                <Link
                  href={sel ? `/superchart?strategy_id=${sel.strategy_id}&backtest_id=${sel.id}` : "#"}
                  onClick={(e) => { if (!sel) e.preventDefault(); }}
                  className={`${btnBase} ${!sel ? btnOff : ""}`}
                >Superchart</Link>
                <Link
                  href={sel ? `/optimization?strategy_id=${sel.strategy_id}&pair=${sel.pair}&timeframe=${sel.timeframe}&period_start=${sel.period_start.slice(0,10)}&period_end=${sel.period_end.slice(0,10)}` : "#"}
                  onClick={(e) => { if (!sel) e.preventDefault(); }}
                  className={`${btnBase} ${!sel ? btnOff : ""}`}
                >Optimize</Link>
                <Link
                  href={sel ? `/copilot?strategy_id=${sel.strategy_id}` : "#"}
                  onClick={(e) => { if (!sel) e.preventDefault(); }}
                  className={`${btnBase} ${!sel ? btnOff : ""}`}
                >Refine</Link>
                <button
                  disabled={!sel}
                  onClick={() => setDiagnosisOpen(true)}
                  className={`${btnBase} ${!sel ? "opacity-30 cursor-not-allowed" : ""}`}
                >Diagnose</button>
                <div className="flex items-center gap-1">
                  {(() => {
                    const deleteIds = checkedIds.size > 0 ? checkedIds : sel ? new Set([sel.id]) : new Set<string>();
                    const canDelete = deleteIds.size > 0;
                    return confirmingDelete ? (
                      <div className="flex flex-col gap-0.5">
                        <button
                          onClick={async () => {
                            await Promise.allSettled(
                              [...deleteIds].map((id) =>
                                fetchWithAuth(`/api/backtest/results/${id}`, { method: "DELETE" })
                              )
                            );
                            setHistory((prev) => prev.filter((r) => !deleteIds.has(r.id)));
                            if (selectedId && deleteIds.has(selectedId)) setSelectedId(null);
                            setCheckedIds(new Set());
                            setConfirmingDelete(false);
                          }}
                          className="rounded bg-red-600 px-1.5 py-0.5 text-[10px] text-white hover:bg-red-500 transition-colors"
                        >
                          {deleteIds.size > 1 ? `Delete ${deleteIds.size}` : "Confirm"}
                        </button>
                        <button
                          onClick={() => setConfirmingDelete(false)}
                          className="rounded border border-blue-700 px-1.5 py-0.5 text-[10px] text-blue-400 hover:bg-blue-900/30 transition-colors"
                        >
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <button
                        disabled={!canDelete}
                        title={checkedIds.size > 1 ? `Delete ${checkedIds.size} backtests` : "Delete backtest"}
                        onClick={() => { if (canDelete) setConfirmingDelete(true); }}
                        className="flex items-center gap-1 rounded border border-red-800 p-0.5 text-red-400 hover:bg-red-900/30 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                      >
                        <svg xmlns="http://www.w3.org/2000/svg" className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <polyline points="3 6 5 6 21 6" />
                          <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                          <path d="M10 11v6" /><path d="M14 11v6" />
                          <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
                        </svg>
                        {checkedIds.size > 1 && (
                          <span className="text-[10px] font-mono">{checkedIds.size}</span>
                        )}
                      </button>
                    );
                  })()}
                  {history.length > 0 && (
                    <input
                      type="checkbox"
                      title="Select all"
                      checked={checkedIds.size === history.length}
                      ref={(el) => {
                        if (el) el.indeterminate = checkedIds.size > 0 && checkedIds.size < history.length;
                      }}
                      onChange={(e) => {
                        if (e.target.checked) setCheckedIds(new Set(history.map((r) => r.id)));
                        else setCheckedIds(new Set());
                      }}
                      className="h-3 w-3 accent-blue-500 cursor-pointer ml-0.5"
                    />
                  )}
                </div>
              </div>
            );
          })()}

          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <h2 className="text-xs font-medium text-gray-500 uppercase tracking-wider">
                Recent runs{checkedIds.size > 0 ? ` · ${checkedIds.size} selected` : ""}
              </h2>
            </div>
            {history.length > 1 && (
              <div className="flex items-center gap-1">
                {(Object.keys(SORT_LABELS) as SortKey[]).map((k) => {
                  const active = sortKey === k;
                  return (
                    <button
                      key={k}
                      onClick={() => {
                        if (active) setSortDir((d) => d === "asc" ? "desc" : "asc");
                        else { setSortKey(k); setSortDir(k === "created_at" ? "desc" : "desc"); }
                      }}
                      className={`text-[10px] px-1.5 py-0.5 rounded transition-colors ${
                        active
                          ? "bg-blue-700 text-white"
                          : "text-gray-500 hover:text-gray-300"
                      }`}
                    >
                      {SORT_LABELS[k]}{active ? (sortDir === "asc" ? " ↑" : " ↓") : ""}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
          {history.length === 0 ? (
            <p className="text-sm text-gray-600">No completed backtests yet.</p>
          ) : (
            <div className="space-y-1">
              {sortRuns(history, sortKey, sortDir).map((r) => (
                <div
                  key={r.id}
                  className={[
                    "rounded-lg border transition-colors cursor-pointer",
                    selectedId === r.id
                      ? "border-blue-600 bg-blue-900/20"
                      : checkedIds.has(r.id)
                      ? "border-blue-800 bg-blue-900/10"
                      : "border-gray-800 hover:border-gray-700 hover:bg-gray-800/50",
                  ].join(" ")}
                  onClick={() => setSelectedId(r.id === selectedId ? null : r.id)}
                >
                  <div className="px-3 py-2.5">
                    <div className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={checkedIds.has(r.id)}
                        onChange={(e) => {
                          e.stopPropagation();
                          setCheckedIds((prev) => {
                            const next = new Set(prev);
                            if (e.target.checked) next.add(r.id);
                            else next.delete(r.id);
                            return next;
                          });
                        }}
                        onClick={(e) => e.stopPropagation()}
                        className="h-3 w-3 shrink-0 accent-blue-500 cursor-pointer"
                      />
                      <span className="text-xs font-medium text-gray-200">{r.pair}</span>
                      <span className="text-xs text-gray-500">{r.timeframe}</span>
                      <div className={`ml-auto text-right ${r.total_pnl >= 0 ? "text-green-400" : "text-red-400"}`}>
                        <div className="text-xs font-medium">{r.total_pnl >= 0 ? "+" : ""}${fmt(r.total_pnl, 0)}</div>
                        <div className="text-[10px] opacity-70">{r.total_pnl >= 0 ? "+" : ""}{(r.total_pnl / 1000).toFixed(2)}%</div>
                      </div>
                    </div>
                    {(() => {
                      const strat = strategies.find((s) => s.id === r.strategy_id);
                      return strat ? (
                        <div className="text-[10px] text-zinc-400 mt-0.5 pl-5 truncate" title={strat.description}>
                          {strat.description}
                        </div>
                      ) : null;
                    })()}
                    <div className="flex items-center gap-3 mt-1 text-xs pl-5">
                      <span className="text-gray-300">Sh <span className="font-medium">{fmt(r.sharpe)}</span></span>
                      <span className="text-gray-300">WR <span className="font-medium">{fmtPct(r.win_rate)}</span></span>
                      <span className="text-gray-300">Tr <span className="font-medium">{r.trade_count ?? "—"}</span></span>
                    </div>
                    <div className="flex items-center justify-between mt-1 pl-5">
                      <span className="text-[10px] text-gray-600">{r.period_start.slice(0, 10)} → {r.period_end.slice(0, 10)}</span>
                      <span className="text-[10px] text-gray-600">{fmtDate(r.created_at)}</span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* ── Right panel: result detail ── */}
      {selectedId ? (
        <div className="flex-1 overflow-y-auto pl-6 min-w-0">
          <BacktestResultPanel
            id={selectedId}
            onClose={() => { setSelectedId(null); setDiagnosisOpen(false); }}
          />
        </div>
      ) : (
        <div className="flex-1 flex items-center justify-center text-sm text-gray-700 select-none">
          {history.length > 0 ? "← Select a run to view results" : ""}
        </div>
      )}

      {/* ── Diagnosis sidebar ── */}
      {diagnosisOpen && selectedId && (() => {
        const run = history.find((r) => r.id === selectedId);
        const strat = run ? strategies.find((s) => s.id === run.strategy_id) : null;
        if (!run || !strat) return null;
        return (
          <DiagnosisSidebar
            backtestRunId={selectedId}
            strategyId={run.strategy_id}
            strategyIr={strat.ir_json}
            pair={run.pair}
            timeframe={run.timeframe}
            periodStart={run.period_start.slice(0, 10)}
            periodEnd={run.period_end.slice(0, 10)}
            onClose={() => setDiagnosisOpen(false)}
          />
        );
      })()}
    </div>
  );
}
