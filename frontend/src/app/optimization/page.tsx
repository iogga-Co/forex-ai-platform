"use client";

import { FormEvent, Suspense, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { fetchWithAuth } from "@/lib/auth";
import { loadSettings } from "@/lib/settings";

// ---------------------------------------------------------------------------
// Form persistence helpers
// ---------------------------------------------------------------------------
const OPT_FORM_KEY = "opt_form";

function optFormLoad(): Partial<Record<string, string>> {
  try { return JSON.parse(localStorage.getItem(OPT_FORM_KEY) ?? "{}"); } catch { return {}; }
}
function optFormSave(form: Record<string, string>) {
  try { localStorage.setItem(OPT_FORM_KEY, JSON.stringify(form)); } catch {}
}
function optFormClear() {
  try { localStorage.removeItem(OPT_FORM_KEY); } catch {}
}

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
// IR param helpers
// ---------------------------------------------------------------------------
interface ParamDef { key: string; label: string; step: number; min: number; isInt?: boolean }

function getConditionParams(cond: Record<string, unknown>): ParamDef[] {
  switch (cond.indicator as string) {
    case "MACD":
      return [
        { key: "fast",          label: "fast", step: 1, min: 1, isInt: true },
        { key: "slow",          label: "slow", step: 1, min: 1, isInt: true },
        { key: "signal_period", label: "sig",  step: 1, min: 1, isInt: true },
      ];
    case "BB":
      return [
        { key: "period",  label: "period", step: 1,   min: 2, isInt: true },
        { key: "std_dev", label: "σ",      step: 0.1, min: 0.1 },
      ];
    case "STOCH":
      return [
        { key: "k_smooth", label: "K", step: 1, min: 1, isInt: true },
        { key: "d_period", label: "D", step: 1, min: 1, isInt: true },
      ];
    default: {
      const params: ParamDef[] = [{ key: "period", label: "period", step: 1, min: 1, isInt: true }];
      if ("value" in cond) params.push({ key: "value", label: "val", step: 0.1, min: 0 });
      return params;
    }
  }
}

function getExitParams(cond: Record<string, unknown>): ParamDef[] {
  if (cond.type === "atr") return [
    { key: "period",     label: "period", step: 1,   min: 1, isInt: true },
    { key: "multiplier", label: "mult",   step: 0.1, min: 0.1 },
  ];
  return [{ key: "value", label: cond.type === "pct" ? "%" : "pips", step: cond.type === "pct" ? 0.1 : 1, min: 0.1 }];
}

interface OptRun {
  id: string;
  status: string;
  pair: string;
  timeframe: string;
  period_start: string;
  period_end: string;
  max_iterations: number;
  current_iteration: number;
  best_sharpe: number | null;
  best_win_rate: number | null;
  best_iteration: number | null;
  stop_reason: string | null;
  created_at: string;
  initial_strategy_id: string | null;
  system_prompt: string;
  user_prompt: string;
  time_limit_minutes: number;
  target_sharpe: number | null;
  target_win_rate: number | null;
}

interface Iteration {
  iteration: number;
  sharpe: number | null;
  win_rate: number | null;
  max_dd: number | null;
  total_pnl: number | null;
  trade_count: number | null;
  ai_analysis: string | null;
  ai_changes: string | null;
  created_at: string;
  strategy_ir?: Record<string, unknown> | null;
}

interface SseEvent {
  event: string;
  iteration?: number;
  max_iterations?: number;
  sharpe?: number;
  win_rate?: number;
  trade_count?: number;
  is_best?: boolean;
  ai_analysis?: string;
  ai_changes?: string;
  stop_reason?: string;
  best_sharpe?: number;
  best_win_rate?: number;
  msg?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "";
const PAIRS = ["EURUSD", "GBPUSD", "USDJPY", "EURGBP", "GBPJPY", "USDCHF"];
const TIMEFRAMES = ["1m", "5m", "15m", "30m", "1H", "4H", "1D"];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function fmt(v: number | null | undefined, d = 3): string {
  return v == null ? "—" : v.toFixed(d);
}
function fmtPct(v: number | null | undefined): string {
  return v == null ? "—" : (v * 100).toFixed(1) + "%";
}
function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", {
    day: "2-digit", month: "short", year: "numeric",
  });
}
function statusColor(status: string): string {
  switch (status) {
    case "running": return "text-blue-400";
    case "completed": return "text-green-400";
    case "failed": return "text-red-400";
    case "stopped": return "text-yellow-400";
    default: return "text-zinc-400";
  }
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function IterationRow({
  iter,
  isBest,
  isSelected,
  isChecked,
  onSelect,
  onCheck,
}: {
  iter: Iteration;
  isBest: boolean;
  isSelected: boolean;
  isChecked: boolean;
  onSelect: () => void;
  onCheck: (checked: boolean) => void;
}) {
  return (
    <tr
      className={[
        "border-b border-zinc-700 cursor-pointer transition-colors",
        isSelected
          ? "bg-blue-900/40 hover:bg-blue-900/50"
          : isChecked
          ? "bg-blue-900/10 border-blue-800"
          : isBest
          ? "bg-green-900/20 hover:bg-zinc-700/40"
          : "hover:bg-zinc-700/40",
      ].join(" ")}
      onClick={onSelect}
    >
      <td className="px-2 py-2 text-center" onClick={(e) => e.stopPropagation()}>
        <input
          type="checkbox"
          checked={isChecked}
          onChange={(e) => onCheck(e.target.checked)}
          className="h-3 w-3 accent-blue-500 cursor-pointer"
        />
      </td>
      <td className="px-3 py-2 text-center">
        {iter.iteration}
        {isBest && <span className="ml-1 text-green-400 text-xs">★</span>}
      </td>
      <td className="px-3 py-2 text-right">{fmt(iter.sharpe)}</td>
      <td className="px-3 py-2 text-right">{fmtPct(iter.win_rate)}</td>
      <td className="px-3 py-2 text-right">{fmtPct(iter.max_dd)}</td>
      <td className="px-3 py-2 text-right">{iter.trade_count ?? "—"}</td>
      <td className={`px-3 py-2 text-right font-medium ${iter.total_pnl == null ? "text-zinc-400" : iter.total_pnl >= 0 ? "text-green-400" : "text-red-400"}`}>
        {iter.total_pnl == null ? "—" : `${iter.total_pnl >= 0 ? "+" : ""}$${iter.total_pnl.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`}
      </td>
      <td className="px-3 py-2 text-zinc-400 text-xs truncate max-w-xs">{iter.ai_changes ?? "—"}</td>
    </tr>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------
export default function OptimizationPage() {
  return (
    <Suspense>
      <OptimizationPageInner />
    </Suspense>
  );
}

function OptimizationPageInner() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const [strategies, setStrategies] = useState<Strategy[]>([]);
  const [runs, setRuns] = useState<OptRun[]>([]);
  const [selectedRun, setSelectedRun] = useState<OptRun | null>(null);
  const [checkedRunIds, setCheckedRunIds] = useState<Set<string>>(new Set());
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [iterations, setIterations] = useState<Iteration[]>([]);
  const [liveEvents, setLiveEvents] = useState<SseEvent[]>([]);
  const [selectedIter, setSelectedIter] = useState<Iteration | null>(null);
  const [iterActionBusy, setIterActionBusy] = useState(false);
  const [iterActionError, setIterActionError] = useState<string | null>(null);
  const [checkedIterIds, setCheckedIterIds] = useState<Set<number>>(new Set());
  const [confirmingIterDelete, setConfirmingIterDelete] = useState(false);

  const cfg = loadSettings();
  const [form, setForm] = useState(() => {
    const saved = optFormLoad();
    return {
      strategy_id:        searchParams.get("strategy_id")   ?? saved.strategy_id        ?? "",
      pair:               searchParams.get("pair")          ?? saved.pair               ?? cfg.default_pair,
      timeframe:          searchParams.get("timeframe")     ?? saved.timeframe          ?? cfg.default_timeframe,
      period_start:       searchParams.get("period_start")  ?? saved.period_start       ?? cfg.default_period_start,
      period_end:         searchParams.get("period_end")    ?? saved.period_end         ?? cfg.default_period_end,
      system_prompt:      saved.system_prompt      ?? "",
      user_prompt:        saved.user_prompt        ?? "",
      max_iterations:     saved.max_iterations     ?? String(cfg.default_max_iterations),
      time_limit_minutes: saved.time_limit_minutes ?? String(cfg.default_time_limit_minutes),
      target_sharpe:      saved.target_sharpe      ?? "",
      target_win_rate:    saved.target_win_rate    ?? "",
    };
  });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notLoggedIn, setNotLoggedIn] = useState(false);
  const [sortCol, setSortCol] = useState<"iteration" | "sharpe" | "win_rate" | "max_dd" | "trade_count" | "total_pnl">("iteration");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [editedIr, setEditedIr] = useState<Record<string, unknown> | null>(null);
  const [irDirty, setIrDirty] = useState(false);

  const esRef    = useRef<EventSource | null>(null);
  const esBackoff = useRef(1000); // ms — doubles on each onerror, resets on onopen

  // Persist form to localStorage on every change
  useEffect(() => { optFormSave(form); }, [form]);

  function handleFormReset() {
    optFormClear();
    setForm({
      strategy_id: "", pair: cfg.default_pair, timeframe: cfg.default_timeframe,
      period_start: cfg.default_period_start, period_end: cfg.default_period_end,
      system_prompt: "", user_prompt: "",
      max_iterations: String(cfg.default_max_iterations),
      time_limit_minutes: String(cfg.default_time_limit_minutes),
      target_sharpe: "", target_win_rate: "",
    });
  }

  // Load strategies and runs on mount; auto-select any currently running run
  useEffect(() => {
    if (!localStorage.getItem("access_token")) {
      setNotLoggedIn(true);
      return;
    }
    loadStrategies();
    loadRuns().then((fetchedRuns) => {
      if (!fetchedRuns) return;
      const running = fetchedRuns.find((r) => r.status === "running");
      if (running) {
        selectRun(running);
      }
    });
  }, []);

  // When selected strategy changes, load its IR into the editable state
  useEffect(() => {
    if (!form.strategy_id) { setEditedIr(null); setIrDirty(false); return; }
    const s = strategies.find((s) => s.id === form.strategy_id);
    if (s?.ir_json) {
      setEditedIr(JSON.parse(JSON.stringify(s.ir_json)));
      setIrDirty(false);
    }
  }, [form.strategy_id, strategies]); // eslint-disable-line react-hooks/exhaustive-deps

  function updateEntryParam(idx: number, key: string, value: number) {
    setEditedIr((prev) => {
      if (!prev) return prev;
      const next = JSON.parse(JSON.stringify(prev));
      (next.entry_conditions as Record<string, unknown>[])[idx][key] = value;
      return next;
    });
    setIrDirty(true);
  }

  function updateExitParam(side: "stop_loss" | "take_profit", key: string, value: number) {
    setEditedIr((prev) => {
      if (!prev) return prev;
      const next = JSON.parse(JSON.stringify(prev));
      if (!next.exit_conditions) next.exit_conditions = {};
      (next.exit_conditions as Record<string, unknown>)[side] = {
        ...((next.exit_conditions as Record<string, unknown>)[side] as object ?? {}),
        [key]: value,
      };
      return next;
    });
    setIrDirty(true);
  }

  function updateSizingParam(key: string, value: number) {
    setEditedIr((prev) => {
      if (!prev) return prev;
      const next = JSON.parse(JSON.stringify(prev));
      next.position_sizing = { ...(next.position_sizing as object ?? {}), [key]: value };
      return next;
    });
    setIrDirty(true);
  }

  async function loadStrategies() {
    try {
      const res = await fetchWithAuth(`${API_BASE}/api/strategies`);
      if (!res.ok) return;
      const data = await res.json();
      setStrategies(data);
      if (data.length > 0 && !form.strategy_id) {
        setForm((f) => ({ ...f, strategy_id: data[0].id }));
      }
    } catch {
      // non-fatal
    }
  }

  async function loadRuns(): Promise<OptRun[] | null> {
    try {
      const res = await fetchWithAuth(`${API_BASE}/api/optimization/runs`);
      if (!res.ok) return null;
      const data: OptRun[] = await res.json();
      setRuns(data);
      return data;
    } catch {
      return null;
    }
  }

  async function loadIterations(runId: string) {
    try {
      const res = await fetchWithAuth(`${API_BASE}/api/optimization/runs/${runId}/iterations`);
      if (!res.ok) return;
      const data = await res.json();
      setIterations(data);
    } catch {
      // non-fatal
    }
  }

  function selectRun(run: OptRun) {
    setSelectedRun(run);
    setIterations([]);
    setLiveEvents([]);
    setSelectedIter(null);
    setIterActionError(null);
    loadIterations(run.id);

    // Close any existing SSE connection
    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
    }

    // Subscribe to SSE if run is active
    if (run.status === "running") {
      startSse(run.id);
    }
  }

  function startSse(runId: string) {
    const token = localStorage.getItem("access_token") ?? "";
    // EventSource doesn't support Authorization headers natively;
    // pass token as query param — backend accepts both
    const url = `${API_BASE}/api/optimization/runs/${runId}/stream?token=${encodeURIComponent(token)}`;
    const es = new EventSource(url);
    esRef.current = es;

    es.addEventListener("iteration_complete", (e) => {
      try {
        const data: SseEvent = JSON.parse(e.data);
        setLiveEvents((prev) => [...prev, data]);
        // Refresh iterations list
        loadIterations(runId);
      } catch {
        // ignore
      }
    });

    es.addEventListener("complete", (e) => {
      try {
        const data: SseEvent = JSON.parse(e.data);
        setLiveEvents((prev) => [...prev, data]);
        es.close();
        esRef.current = null;
        toast.success("Optimization complete");
        // Refresh run status
        loadRuns().then(() => {
          fetchWithAuth(`${API_BASE}/api/optimization/runs/${runId}`)
            .then((r) => r.json())
            .then((updated: OptRun) => setSelectedRun(updated));
        });
        loadIterations(runId);
      } catch {
        // ignore
      }
    });

    es.onopen = () => {
      esBackoff.current = 1000; // reset on successful connection
    };

    es.addEventListener("error", () => {
      es.close();
      esRef.current = null;
      // Reconnect with exponential backoff (capped at 30s)
      const delay = esBackoff.current;
      esBackoff.current = Math.min(delay * 2, 30_000);
      setTimeout(() => {
        if (esRef.current === null) startSse(runId);
      }, delay);
    });
  }

  // Cleanup SSE on unmount
  useEffect(() => {
    return () => {
      esRef.current?.close();
    };
  }, []);

  // Reconnect SSE and refresh status when tab regains visibility
  useEffect(() => {
    function onVisible() {
      if (document.visibilityState !== "visible") return;
      loadRuns().then((fetchedRuns) => {
        if (!fetchedRuns) return;
        // If SSE dropped while backgrounded, reconnect to whichever run is still going
        setSelectedRun((prev) => {
          const stillRunning = fetchedRuns.find((r) => r.id === prev?.id && r.status === "running");
          if (stillRunning && !esRef.current) {
            startSse(stillRunning.id);
            loadIterations(stillRunning.id);
          }
          // If we had no run selected, auto-pick the running one
          if (!prev) {
            const running = fetchedRuns.find((r) => r.status === "running");
            if (running) {
              selectRun(running);
              return running;
            }
          }
          return prev ? (fetchedRuns.find((r) => r.id === prev.id) ?? prev) : prev;
        });
      });
    }
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Poll run status every 15 s while a run is active (catches completion in background)
  useEffect(() => {
    if (!selectedRun || selectedRun.status !== "running") return;
    const id = setInterval(async () => {
      try {
        const res = await fetchWithAuth(`${API_BASE}/api/optimization/runs/${selectedRun.id}`);
        if (!res.ok) return;
        const updated: OptRun = await res.json();
        setSelectedRun(updated);
        // Update the run in the list too
        setRuns((prev) => prev.map((r) => r.id === updated.id ? updated : r));
        if (updated.status !== "running") {
          // Run finished while tab was in background — load final iterations
          loadIterations(updated.id);
          esRef.current?.close();
          esRef.current = null;
        }
      } catch {
        // non-fatal
      }
    }, 15_000);
    return () => clearInterval(id);
  }, [selectedRun?.id, selectedRun?.status]); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      // If the user edited the IR, save it as a new strategy first
      let strategyId = form.strategy_id;
      if (irDirty && editedIr) {
        const baseStrategy = strategies.find((s) => s.id === form.strategy_id);
        const seedRes = await fetchWithAuth(`${API_BASE}/api/strategies`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ir_json: editedIr,
            description: `[Opt seed] ${baseStrategy?.description ?? form.strategy_id.slice(0, 8)}`,
            pair: form.pair,
            timeframe: form.timeframe,
          }),
        });
        if (!seedRes.ok) throw new Error("Failed to save modified strategy");
        const newStrategy = await seedRes.json();
        strategyId = newStrategy.id;
        await loadStrategies();
      }

      const body: Record<string, unknown> = {
        strategy_id: strategyId,
        pair: form.pair,
        timeframe: form.timeframe,
        period_start: form.period_start,
        period_end: form.period_end,
        system_prompt: form.system_prompt,
        user_prompt: form.user_prompt,
        max_iterations: parseInt(form.max_iterations, 10),
        time_limit_minutes: parseInt(form.time_limit_minutes, 10),
        model: cfg.ai_model,
      };
      if (form.target_sharpe) body.target_sharpe = parseFloat(form.target_sharpe);
      if (form.target_win_rate) body.target_win_rate = parseFloat(form.target_win_rate) / 100;

      const res = await fetchWithAuth(`${API_BASE}/api/optimization/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail ?? `HTTP ${res.status}`);
      }
      const run: OptRun = await res.json();

      // Start the run immediately
      await fetchWithAuth(`${API_BASE}/api/optimization/runs/${run.id}/start`, {
        method: "POST",
      });

      await loadRuns();
      selectRun({ ...run, status: "running" });
      startSse(run.id);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleStop() {
    if (!selectedRun) return;
    try {
      await fetchWithAuth(`${API_BASE}/api/optimization/runs/${selectedRun.id}/stop`, {
        method: "POST",
      });
    } catch {
      // non-fatal
    }
  }

  function handleResubmit(run: OptRun) {
    setForm({
      strategy_id: run.initial_strategy_id ?? "",
      pair: run.pair,
      timeframe: run.timeframe,
      period_start: run.period_start,
      period_end: run.period_end,
      system_prompt: run.system_prompt,
      user_prompt: run.user_prompt,
      max_iterations: String(run.max_iterations),
      time_limit_minutes: String(run.time_limit_minutes),
      target_sharpe: run.target_sharpe != null ? String(run.target_sharpe) : "",
      target_win_rate: run.target_win_rate != null ? String(Math.round(run.target_win_rate * 100)) : "",
    });
    // Scroll form into view by deselecting the run so the left panel is visible
    setSelectedRun(null);
  }

  async function handleDelete(ids: Set<string>) {
    await Promise.allSettled(
      [...ids].map((id) =>
        fetchWithAuth(`${API_BASE}/api/optimization/runs/${id}`, { method: "DELETE" })
      )
    );
    setRuns((prev) => prev.filter((r) => !ids.has(r.id)));
    if (selectedRun && ids.has(selectedRun.id)) {
      setSelectedRun(null);
      setIterations([]);
      setLiveEvents([]);
      setSelectedIter(null);
      esRef.current?.close();
      esRef.current = null;
    }
    setCheckedRunIds(new Set());
    setConfirmingDelete(false);
  }

  async function saveIterAndNavigate(destination: "backtest" | "optimize" | "refine" | "copilot" | "superchart") {
    if (!selectedIter || !selectedRun) return;
    setIterActionBusy(true);
    setIterActionError(null);
    try {
      // strategy_ir may come back as a parsed object or a JSON string depending on asyncpg version
      const rawIr = selectedIter.strategy_ir;
      if (!rawIr) throw new Error("No strategy IR stored for this iteration");
      const ir: Record<string, unknown> =
        typeof rawIr === "string" ? JSON.parse(rawIr) : (rawIr as Record<string, unknown>);
      const meta = (ir.metadata as Record<string, unknown> | undefined) ?? {};
      const pair = (meta.pair as string | undefined) ?? selectedRun.pair;
      const timeframe = (meta.timeframe as string | undefined) ?? selectedRun.timeframe;
      const label = `[Opt iter ${selectedIter.iteration}] ${selectedRun.pair} ${selectedRun.timeframe}`;

      const res = await fetchWithAuth(`${API_BASE}/api/strategies`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ir_json: ir,
          description: label,
          pair,
          timeframe,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail ?? `HTTP ${res.status}`);
      }
      const saved = await res.json();
      const sid = saved.id;

      if (destination === "backtest") {
        router.push(
          `/backtest?strategy_id=${sid}&pair=${encodeURIComponent(selectedRun.pair)}&timeframe=${encodeURIComponent(selectedRun.timeframe)}&period_start=${encodeURIComponent(selectedRun.period_start)}&period_end=${encodeURIComponent(selectedRun.period_end)}`,
        );
      } else if (destination === "optimize") {
        router.push(
          `/optimization?strategy_id=${sid}&pair=${encodeURIComponent(selectedRun.pair)}&timeframe=${encodeURIComponent(selectedRun.timeframe)}&period_start=${encodeURIComponent(selectedRun.period_start)}&period_end=${encodeURIComponent(selectedRun.period_end)}`,
        );
      } else if (destination === "refine") {
        router.push(`/copilot?strategy_id=${sid}&refine=1`);
      } else if (destination === "copilot") {
        router.push(`/copilot?strategy_id=${sid}`);
      } else {
        router.push(`/superchart?strategy_id=${sid}`);
      }
    } catch (err: unknown) {
      setIterActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setIterActionBusy(false);
    }
  }

  if (notLoggedIn) {
    return (
      <div className="flex h-screen items-center justify-center bg-zinc-900 text-zinc-300">
        Please log in to use the Optimization tab.
      </div>
    );
  }

  return (
    <div className="flex h-screen bg-zinc-900 text-zinc-200 overflow-hidden">
      {/* ------------------------------------------------------------------ */}
      {/* Left panel — new run form                                           */}
      {/* ------------------------------------------------------------------ */}
      <aside className="w-52 flex-shrink-0 border-r border-zinc-700 flex flex-col overflow-hidden">
        {/* New run form — takes full height, scrollable */}
        <div className="flex-1 overflow-y-auto p-3">
          <h3 className="text-[10px] font-semibold text-zinc-400 uppercase tracking-wide mb-2">New Run</h3>
          <form onSubmit={handleSubmit} className="space-y-0.5">

            {/* Strategy */}
            <div>
              <label className="text-[10px] text-zinc-500 leading-none">Strategy</label>
              <select
                className="w-full bg-zinc-800 border border-zinc-600 rounded px-2 py-0.5 text-xs text-zinc-200"
                value={form.strategy_id}
                onChange={(e) => setForm((f) => ({ ...f, strategy_id: e.target.value }))}
                required
              >
                <option value="">Select…</option>
                {strategies.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.description || s.id.slice(0, 8)} ({s.pair} {s.timeframe})
                  </option>
                ))}
              </select>
            </div>

            {/* Indicator Parameters */}
            {editedIr && (() => {
              const entryConds = (editedIr.entry_conditions as Record<string, unknown>[]) ?? [];
              const exitConds  = editedIr.exit_conditions as Record<string, Record<string, unknown>> | undefined;
              const sizing     = editedIr.position_sizing as Record<string, unknown> | undefined;
              const inputCls   = "w-14 bg-zinc-700 border border-zinc-600 rounded px-1 py-0.5 text-xs text-zinc-200 text-right";
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
                          <span className="text-[10px] text-zinc-500 leading-none">{p.label}</span>
                          <input type="number" step={p.step} min={p.min} value={Number(cond[p.key] ?? 0)}
                            onChange={(e) => updateEntryParam(idx, p.key, p.isInt ? parseInt(e.target.value, 10) : parseFloat(e.target.value))}
                            className={inputCls} />
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
                        <span className="text-[10px] text-zinc-500 leading-none">{String(ec.type)}</span>
                        {getExitParams(ec).map((p) => (
                          <label key={p.key} className="flex items-center gap-0.5">
                            <span className="text-[10px] text-zinc-500 leading-none">{p.label}</span>
                            <input type="number" step={p.step} min={p.min} value={Number(ec[p.key] ?? 0)}
                              onChange={(e) => updateExitParam(side, p.key, p.isInt ? parseInt(e.target.value, 10) : parseFloat(e.target.value))}
                              className={inputCls} />
                          </label>
                        ))}
                      </div>
                    );
                  })}
                  {sizing && (
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="text-[10px] text-zinc-300 w-10 shrink-0">Size</span>
                      <label className="flex items-center gap-0.5">
                        <span className="text-[10px] text-zinc-500 leading-none">risk%</span>
                        <input type="number" step={0.1} min={0.1} value={Number(sizing.risk_per_trade_pct ?? 1)}
                          onChange={(e) => updateSizingParam("risk_per_trade_pct", parseFloat(e.target.value))}
                          className={inputCls} />
                      </label>
                      <label className="flex items-center gap-0.5">
                        <span className="text-[10px] text-zinc-500 leading-none">max</span>
                        <input type="number" step={1000} min={1000} value={Number(sizing.max_size_units ?? 100000)}
                          onChange={(e) => updateSizingParam("max_size_units", parseInt(e.target.value, 10))}
                          className="w-20 bg-zinc-700 border border-zinc-600 rounded px-1 py-0.5 text-xs text-zinc-200 text-right" />
                      </label>
                    </div>
                  )}
                </div>
              );
            })()}

            {/* Pair · TF · Start · End — 2×2 grid */}
            <div className="grid grid-cols-2 gap-x-2 gap-y-0.5">
              <div>
                <label className="text-[10px] text-zinc-500 leading-none">Pair</label>
                <select className="w-full bg-zinc-800 border border-zinc-600 rounded px-2 py-0.5 text-xs text-zinc-200"
                  value={form.pair} onChange={(e) => setForm((f) => ({ ...f, pair: e.target.value }))}>
                  {PAIRS.map((p) => <option key={p}>{p}</option>)}
                </select>
              </div>
              <div>
                <label className="text-[10px] text-zinc-500 leading-none">TF</label>
                <select className="w-full bg-zinc-800 border border-zinc-600 rounded px-2 py-0.5 text-xs text-zinc-200"
                  value={form.timeframe} onChange={(e) => setForm((f) => ({ ...f, timeframe: e.target.value }))}>
                  {TIMEFRAMES.map((t) => <option key={t}>{t}</option>)}
                </select>
              </div>
              <div>
                <label className="text-[10px] text-zinc-500 leading-none">Start</label>
                <input type="date" required
                  className="w-full bg-zinc-800 border border-zinc-600 rounded px-2 py-0.5 text-xs text-zinc-200"
                  value={form.period_start} onChange={(e) => setForm((f) => ({ ...f, period_start: e.target.value }))} />
              </div>
              <div>
                <label className="text-[10px] text-zinc-500 leading-none">End</label>
                <input type="date" required
                  className="w-full bg-zinc-800 border border-zinc-600 rounded px-2 py-0.5 text-xs text-zinc-200"
                  value={form.period_end} onChange={(e) => setForm((f) => ({ ...f, period_end: e.target.value }))} />
              </div>
            </div>

            {/* Iters · Time · Sharpe · WR — 2×2 grid */}
            <div className="grid grid-cols-2 gap-x-2 gap-y-0.5">
              <div>
                <label className="text-[10px] text-zinc-500 leading-none">Max iters</label>
                <input type="number" min={1} max={100} required
                  className="w-full bg-zinc-800 border border-zinc-600 rounded px-2 py-0.5 text-xs text-zinc-200"
                  value={form.max_iterations} onChange={(e) => setForm((f) => ({ ...f, max_iterations: e.target.value }))} />
              </div>
              <div>
                <label className="text-[10px] text-zinc-500 leading-none">Time limit (min)</label>
                <input type="number" min={1} max={600} required
                  className="w-full bg-zinc-800 border border-zinc-600 rounded px-2 py-0.5 text-xs text-zinc-200"
                  value={form.time_limit_minutes} onChange={(e) => setForm((f) => ({ ...f, time_limit_minutes: e.target.value }))} />
              </div>
              <div>
                <label className="text-[10px] text-zinc-500 leading-none">Target Sharpe</label>
                <input type="number" step="0.01" placeholder="e.g. 1.5"
                  className="w-full bg-zinc-800 border border-zinc-600 rounded px-2 py-0.5 text-xs text-zinc-200"
                  value={form.target_sharpe} onChange={(e) => setForm((f) => ({ ...f, target_sharpe: e.target.value }))} />
              </div>
              <div>
                <label className="text-[10px] text-zinc-500 leading-none">Target WR %</label>
                <input type="number" step="1" min={0} max={100} placeholder="e.g. 55"
                  className="w-full bg-zinc-800 border border-zinc-600 rounded px-2 py-0.5 text-xs text-zinc-200"
                  value={form.target_win_rate} onChange={(e) => setForm((f) => ({ ...f, target_win_rate: e.target.value }))} />
              </div>
            </div>

            {/* Prompts */}
            <div>
              <label className="text-[10px] text-zinc-500 leading-none">Goal</label>
              <textarea rows={2} placeholder="e.g. Maximize Sharpe while keeping drawdown below 15%"
                className="w-full bg-zinc-800 border border-zinc-600 rounded px-2 py-0.5 text-xs text-zinc-200 resize-none"
                value={form.system_prompt} onChange={(e) => setForm((f) => ({ ...f, system_prompt: e.target.value }))} />
            </div>
            <div>
              <label className="text-[10px] text-zinc-500 leading-none">Additional instruction</label>
              <textarea rows={2} placeholder="e.g. Focus on improving win rate first"
                className="w-full bg-zinc-800 border border-zinc-600 rounded px-2 py-0.5 text-xs text-zinc-200 resize-none"
                value={form.user_prompt} onChange={(e) => setForm((f) => ({ ...f, user_prompt: e.target.value }))} />
            </div>

            {error && <p className="text-xs text-red-400">{error}</p>}

            <button
              type="submit"
              disabled={submitting || !form.strategy_id}
              className="w-full bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-xs font-semibold py-1.5 rounded transition-colors"
            >
              {submitting ? "Starting…" : "Start Optimization"}
            </button>
            <button
              type="button"
              onClick={handleFormReset}
              className="w-full text-[10px] text-zinc-500 hover:text-zinc-300 transition-colors mt-1"
            >
              Reset to defaults
            </button>
          </form>
        </div>
      </aside>

      {/* ------------------------------------------------------------------ */}
      {/* Optimization runs list                                              */}
      {/* ------------------------------------------------------------------ */}
      <aside className="w-48 flex-shrink-0 border-r border-zinc-700 flex flex-col overflow-hidden">
        <div className="px-3 py-2 border-b border-zinc-700 flex-shrink-0 flex items-center justify-between gap-1">
          <h2 className="text-[10px] font-semibold text-zinc-400 uppercase tracking-wide truncate">
            Optimization Runs{checkedRunIds.size > 0 ? ` · ${checkedRunIds.size}` : ""}
          </h2>
          <div className="flex items-center gap-1 shrink-0">
            {confirmingDelete ? (
              <div className="flex flex-col gap-0.5">
                <button
                  onClick={() => {
                    const ids = checkedRunIds.size > 0 ? checkedRunIds : selectedRun ? new Set([selectedRun.id]) : new Set<string>();
                    handleDelete(ids);
                  }}
                  className="rounded bg-red-600 px-1.5 py-0.5 text-[10px] text-white hover:bg-red-500 transition-colors"
                >
                  {checkedRunIds.size > 1 ? `Delete ${checkedRunIds.size}` : "Confirm"}
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
                disabled={checkedRunIds.size === 0 && !selectedRun}
                onClick={() => setConfirmingDelete(true)}
                className="flex items-center gap-1 rounded border border-red-800 p-0.5 text-red-400 hover:bg-red-900/30 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                title={checkedRunIds.size > 1 ? `Delete ${checkedRunIds.size} runs` : "Delete run"}
              >
                <svg xmlns="http://www.w3.org/2000/svg" className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="3 6 5 6 21 6" />
                  <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                  <path d="M10 11v6" /><path d="M14 11v6" />
                  <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
                </svg>
                {checkedRunIds.size > 1 && (
                  <span className="text-[10px] font-mono">{checkedRunIds.size}</span>
                )}
              </button>
            )}
            {runs.length > 0 && (
              <input
                type="checkbox"
                title="Select all"
                checked={checkedRunIds.size === runs.length && runs.length > 0}
                ref={(el) => {
                  if (el) el.indeterminate = checkedRunIds.size > 0 && checkedRunIds.size < runs.length;
                }}
                onChange={(e) => {
                  if (e.target.checked) setCheckedRunIds(new Set(runs.map((r) => r.id)));
                  else setCheckedRunIds(new Set());
                }}
                className="h-3 w-3 accent-blue-500 cursor-pointer"
              />
            )}
          </div>
        </div>
        <div className="flex-1 overflow-y-auto">
          {runs.length === 0 && (
            <p className="p-4 text-xs text-zinc-500">No runs yet.</p>
          )}
          {runs.map((run) => (
            <div
              key={run.id}
              onClick={() => selectRun(run)}
              className={`w-full text-left px-3 py-3 border-b border-zinc-700 hover:bg-zinc-700/50 transition-colors cursor-pointer ${
                selectedRun?.id === run.id
                  ? "bg-zinc-700"
                  : checkedRunIds.has(run.id)
                  ? "bg-blue-900/10 border-blue-800"
                  : ""
              }`}
            >
              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={checkedRunIds.has(run.id)}
                  onChange={(e) => {
                    e.stopPropagation();
                    setCheckedRunIds((prev) => {
                      const next = new Set(prev);
                      if (e.target.checked) next.add(run.id);
                      else next.delete(run.id);
                      return next;
                    });
                  }}
                  onClick={(e) => e.stopPropagation()}
                  className="h-3 w-3 shrink-0 accent-blue-500 cursor-pointer"
                />
                <span className="text-xs font-mono text-zinc-300 truncate">
                  {run.pair} {run.timeframe}
                </span>
                <span className={`text-xs font-semibold ml-auto shrink-0 ${statusColor(run.status)}`}>
                  {run.status}
                </span>
              </div>
              {run.initial_strategy_id && (() => {
                const strat = strategies.find((s) => s.id === run.initial_strategy_id);
                return strat ? (
                  <div className="text-[10px] text-zinc-400 mt-0.5 pl-5 truncate" title={strat.description}>
                    {strat.description}
                  </div>
                ) : null;
              })()}
              <div className="text-xs text-zinc-500 mt-0.5 pl-5">
                {fmtDate(run.created_at)} · {run.current_iteration}/{run.max_iterations} iter
              </div>
              {run.best_sharpe !== null && (
                <div className="text-xs text-zinc-400 mt-0.5 pl-5">
                  S: {fmt(run.best_sharpe)} · WR: {fmtPct(run.best_win_rate)}
                </div>
              )}
              {run.status !== "running" && (
                <div
                  className="mt-2 pl-5"
                  onClick={(e) => e.stopPropagation()}
                >
                  <button
                    onClick={() => handleResubmit(run)}
                    className="w-full text-xs bg-zinc-700 hover:bg-zinc-600 text-zinc-200 rounded px-2 py-1 transition-colors"
                  >
                    Resubmit
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      </aside>

      {/* ------------------------------------------------------------------ */}
      {/* Main panel — selected run detail                                    */}
      {/* ------------------------------------------------------------------ */}
      <main className="flex-1 flex flex-col overflow-hidden min-w-0">
        {!selectedRun ? (
          <div className="flex-1 flex items-center justify-center text-zinc-500 text-sm">
            Select or start an optimization run.
          </div>
        ) : (
          <>
            {/* Header */}
            <div className="px-6 py-4 border-b border-zinc-700 flex items-center justify-between flex-shrink-0">
              <div>
                <h1 className="text-base font-semibold text-zinc-100">
                  {selectedRun.pair} {selectedRun.timeframe} — Optimization Run
                </h1>
                <p className="text-xs text-zinc-500 mt-0.5">
                  {fmtDate(selectedRun.period_start)} → {fmtDate(selectedRun.period_end)} ·
                  {" "}iter {selectedRun.current_iteration}/{selectedRun.max_iterations} ·{" "}
                  <span className={statusColor(selectedRun.status)}>{selectedRun.status}</span>
                  {selectedRun.stop_reason && ` (${selectedRun.stop_reason})`}
                </p>
              </div>
              <div className="flex items-center gap-3">
                {selectedRun.best_sharpe !== null && (
                  <div className="text-right">
                    <p className="text-xs text-zinc-400">Best (iter {selectedRun.best_iteration})</p>
                    <p className="text-sm font-semibold text-green-400">
                      Sharpe {fmt(selectedRun.best_sharpe)} · WR {fmtPct(selectedRun.best_win_rate)}
                    </p>
                  </div>
                )}
                {selectedRun.status === "running" && (
                  <button
                    onClick={handleStop}
                    className="px-3 py-1.5 bg-red-700 hover:bg-red-600 text-white text-xs font-semibold rounded transition-colors"
                  >
                    Stop
                  </button>
                )}
              </div>
            </div>

            <div className="flex-1 flex overflow-hidden">
              {/* Iteration table */}
              <div className="flex-1 overflow-y-auto">
                {/* Live events (running) */}
                {selectedRun.status === "running" && liveEvents.length > 0 && (
                  <div className="px-6 py-3 bg-blue-950/30 border-b border-zinc-700">
                    <p className="text-xs font-semibold text-blue-300 mb-1">Live Progress</p>
                    <div className="space-y-1 max-h-32 overflow-y-auto">
                      {[...liveEvents].reverse().map((ev, i) => (
                        <p key={i} className="text-xs text-zinc-400">
                          {ev.event === "iteration_complete" && (
                            <>
                              <span className="text-zinc-200">Iter {ev.iteration}</span>
                              {" · "}Sharpe {fmt(ev.sharpe)} · WR {fmtPct(ev.win_rate)} · {ev.trade_count} trades
                              {ev.is_best && <span className="ml-1 text-green-400">★ best</span>}
                              {ev.ai_changes && (
                                <span className="ml-2 text-zinc-500">{ev.ai_changes}</span>
                              )}
                            </>
                          )}
                          {ev.event === "complete" && (
                            <span className="text-green-400">
                              Complete — {ev.stop_reason} · Best Sharpe {fmt(ev.best_sharpe)}
                            </span>
                          )}
                          {ev.event === "error" && (
                            <span className="text-red-400">{ev.msg}</span>
                          )}
                          {ev.event === "iteration_start" && (
                            <span className="text-blue-400 animate-pulse">{ev.msg}</span>
                          )}
                        </p>
                      ))}
                    </div>
                  </div>
                )}

                {/* Iterations table */}
                <div className="px-6 py-4">
                  <div className="flex items-center justify-between mb-3">
                    <h2 className="text-xs font-semibold text-zinc-400 uppercase">
                      Iteration History{checkedIterIds.size > 0 ? ` · ${checkedIterIds.size} selected` : ""}
                    </h2>
                    <div className="flex items-center gap-2">
                      {selectedIter && (
                        <span className="text-xs text-zinc-500">
                          Iter {selectedIter.iteration} selected —
                        </span>
                      )}
                      <button
                        disabled={!selectedIter || iterActionBusy}
                        onClick={() => saveIterAndNavigate("backtest")}
                        className="rounded-md border border-blue-700 px-3 py-1.5 text-xs text-blue-400 hover:bg-blue-900/30 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                      >
                        Backtest
                      </button>
                      <button
                        disabled={!selectedIter || iterActionBusy}
                        onClick={() => saveIterAndNavigate("optimize")}
                        className="rounded-md border border-blue-700 px-3 py-1.5 text-xs text-blue-400 hover:bg-blue-900/30 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                      >
                        Optimize
                      </button>
                      <button
                        disabled={!selectedIter || iterActionBusy}
                        onClick={() => saveIterAndNavigate("refine")}
                        className="rounded-md border border-blue-700 px-3 py-1.5 text-xs text-blue-400 hover:bg-blue-900/30 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                      >
                        Refine
                      </button>
                      <button
                        disabled={!selectedIter || iterActionBusy}
                        onClick={() => saveIterAndNavigate("superchart")}
                        className="rounded-md border border-blue-700 px-3 py-1.5 text-xs text-blue-400 hover:bg-blue-900/30 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                      >
                        Superchart
                      </button>
                      {iterActionBusy && (
                        <span className="text-xs text-zinc-400 animate-pulse">Saving…</span>
                      )}
                      {/* Delete iterations */}
                      <div className="flex items-center gap-1">
                        {confirmingIterDelete ? (
                          <div className="flex flex-col gap-0.5">
                            <button
                              onClick={async () => {
                                const ids = checkedIterIds.size > 0 ? checkedIterIds : selectedIter ? new Set([selectedIter.iteration]) : new Set<number>();
                                await Promise.allSettled(
                                  [...ids].map((n) =>
                                    fetchWithAuth(`${API_BASE}/api/optimization/runs/${selectedRun.id}/iterations/${n}`, { method: "DELETE" })
                                  )
                                );
                                setIterations((prev) => prev.filter((it) => !ids.has(it.iteration)));
                                if (selectedIter && ids.has(selectedIter.iteration)) setSelectedIter(null);
                                setCheckedIterIds(new Set());
                                setConfirmingIterDelete(false);
                              }}
                              className="rounded bg-red-600 px-1.5 py-0.5 text-[10px] text-white hover:bg-red-500 transition-colors"
                            >
                              {checkedIterIds.size > 1 ? `Delete ${checkedIterIds.size}` : "Confirm"}
                            </button>
                            <button
                              onClick={() => setConfirmingIterDelete(false)}
                              className="rounded border border-blue-700 px-1.5 py-0.5 text-[10px] text-blue-400 hover:bg-blue-900/30 transition-colors"
                            >
                              Cancel
                            </button>
                          </div>
                        ) : (
                          <button
                            disabled={checkedIterIds.size === 0 && !selectedIter}
                            onClick={() => setConfirmingIterDelete(true)}
                            className="flex items-center gap-1 rounded border border-red-800 p-0.5 text-red-400 hover:bg-red-900/30 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                            title={checkedIterIds.size > 1 ? `Delete ${checkedIterIds.size} iterations` : "Delete iteration"}
                          >
                            <svg xmlns="http://www.w3.org/2000/svg" className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <polyline points="3 6 5 6 21 6" />
                              <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                              <path d="M10 11v6" /><path d="M14 11v6" />
                              <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
                            </svg>
                            {checkedIterIds.size > 1 && (
                              <span className="text-[10px] font-mono">{checkedIterIds.size}</span>
                            )}
                          </button>
                        )}
                        {iterations.length > 0 && (
                          <input
                            type="checkbox"
                            title="Select all"
                            checked={checkedIterIds.size === iterations.length && iterations.length > 0}
                            ref={(el) => {
                              if (el) el.indeterminate = checkedIterIds.size > 0 && checkedIterIds.size < iterations.length;
                            }}
                            onChange={(e) => {
                              if (e.target.checked) setCheckedIterIds(new Set(iterations.map((it) => it.iteration)));
                              else setCheckedIterIds(new Set());
                            }}
                            className="h-3 w-3 accent-blue-500 cursor-pointer"
                          />
                        )}
                      </div>
                    </div>
                  </div>
                  {iterActionError && (
                    <p className="text-xs text-red-400 mt-1">{iterActionError}</p>
                  )}
                  {iterations.length === 0 ? (
                    <p className="text-xs text-zinc-500">
                      {selectedRun.status === "running"
                        ? "Waiting for first iteration to complete…"
                        : "No iterations recorded."}
                    </p>
                  ) : (
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="text-zinc-400 border-b border-zinc-700">
                          <th className="px-2 py-2 w-7" />
                          {(["iteration", "sharpe", "win_rate", "max_dd", "trade_count", "total_pnl"] as const).map((col) => {
                            const labels: Record<string, string> = {
                              iteration: "Iter", sharpe: "Sharpe", win_rate: "Win Rate",
                              max_dd: "Max DD", trade_count: "Trades", total_pnl: "PnL",
                            };
                            const active = sortCol === col;
                            return (
                              <th
                                key={col}
                                onClick={() => {
                                  if (active) setSortDir((d) => d === "asc" ? "desc" : "asc");
                                  else { setSortCol(col); setSortDir("asc"); }
                                }}
                                className={`px-3 py-2 cursor-pointer select-none hover:text-zinc-200 transition-colors ${col === "iteration" ? "text-center w-12" : "text-right"}`}
                              >
                                {labels[col]}
                                <span className="ml-1 inline-block w-2">
                                  {active ? (sortDir === "asc" ? "↑" : "↓") : ""}
                                </span>
                              </th>
                            );
                          })}
                          <th className="px-3 py-2 text-left">Changes</th>
                        </tr>
                      </thead>
                      <tbody>
                        {[...iterations].sort((a, b) => {
                          const av = a[sortCol] ?? (sortDir === "asc" ? Infinity : -Infinity);
                          const bv = b[sortCol] ?? (sortDir === "asc" ? Infinity : -Infinity);
                          return sortDir === "asc" ? (av as number) - (bv as number) : (bv as number) - (av as number);
                        }).map((iter) => (
                          <IterationRow
                            key={iter.iteration}
                            iter={iter}
                            isBest={iter.iteration === selectedRun.best_iteration}
                            isSelected={selectedIter?.iteration === iter.iteration}
                            isChecked={checkedIterIds.has(iter.iteration)}
                            onSelect={() => {
                              setSelectedIter((prev) =>
                                prev?.iteration === iter.iteration ? null : iter
                              );
                              setIterActionError(null);
                            }}
                            onCheck={(checked) => {
                              setCheckedIterIds((prev) => {
                                const next = new Set(prev);
                                if (checked) next.add(iter.iteration);
                                else next.delete(iter.iteration);
                                return next;
                              });
                            }}
                          />
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              </div>

              {/* Right panel — AI analysis + best strategy */}
              {iterations.length > 0 && (
                <aside className="w-72 flex-shrink-0 border-l border-zinc-700 overflow-y-auto p-4 space-y-4">
                  <div>
                    <h3 className="text-xs font-semibold text-zinc-400 uppercase mb-2">
                      {selectedIter
                        ? `AI Analysis (iter ${selectedIter.iteration})`
                        : `Latest AI Analysis (iter ${iterations[iterations.length - 1].iteration})`}
                    </h3>
                    <p className="text-xs text-zinc-300 whitespace-pre-wrap leading-relaxed">
                      {(selectedIter ?? iterations[iterations.length - 1]).ai_analysis || "(none)"}
                    </p>
                  </div>

                </aside>
              )}
            </div>
          </>
        )}
      </main>

    </div>
  );
}
