"use client";

import Link from "next/link";
import { FormEvent, useEffect, useRef, useState } from "react";
import { fetchWithAuth } from "@/lib/auth";
import BacktestResultPanel from "@/components/BacktestResultPanel";
import { loadSettings } from "@/lib/settings";

interface Strategy {
  id: string;
  version: number;
  description: string;
  pair: string;
  timeframe: string;
  ir_json: { metadata?: { name?: string; description?: string } };
}

interface JobStatus {
  status: string;
  progress_pct: number;
  result_id: string | null;
  error: string | null;
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

const PAIRS = ["EURUSD", "GBPUSD", "USDJPY", "EURGBP", "GBPJPY", "USDCHF"];
const TIMEFRAMES = ["1m", "1H"];

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
  const [strategies, setStrategies] = useState<Strategy[]>([]);
  const [history, setHistory] = useState<RunSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>("created_at");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  const cfg = loadSettings();
  const [form, setForm] = useState({
    strategy_id: "",
    pair: cfg.default_pair,
    timeframe: cfg.default_timeframe,
    period_start: cfg.default_period_start,
    period_end: cfg.default_period_end,
    initial_capital: String(cfg.default_initial_capital),
  });
  const [jobId, setJobId] = useState<string | null>(null);
  const [jobStatus, setJobStatus] = useState<JobStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notLoggedIn, setNotLoggedIn] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!localStorage.getItem("access_token")) {
      setNotLoggedIn(true);
      return;
    }

    function loadStrategies() {
      fetchWithAuth("/api/strategies")
        .then((r) => r.json())
        .then((data) => {
          const list: Strategy[] = Array.isArray(data) ? data : data.strategies ?? [];
          setStrategies(list);
          setForm((f) => {
            const stillExists = list.some((s) => s.id === f.strategy_id);
            return stillExists ? f : { ...f, strategy_id: list[0]?.id ?? "" };
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
    const sessionId = crypto.randomUUID();
    try {
      const res = await fetchWithAuth(`/api/backtest?session_id=${sessionId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          strategy_id: form.strategy_id,
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
    s.description || s.ir_json?.metadata?.description?.slice(0, 40) || s.id.slice(0, 8);

  async function handleDeleteRun(id: string, e: React.MouseEvent) {
    e.stopPropagation();
    try {
      await fetchWithAuth(`/api/backtest/results/${id}`, { method: "DELETE" });
      setHistory((prev) => prev.filter((r) => r.id !== id));
      if (selectedId === id) setSelectedId(null);
    } catch {
      // non-fatal
    }
  }

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
      <div className="w-[400px] shrink-0 flex flex-col overflow-y-auto pr-6 border-r border-gray-800">

        {/* Form */}
        <div className="space-y-4 pb-6">
          <div>
            <h1 className="text-xl font-semibold text-gray-100">Backtest</h1>
            <p className="text-sm text-gray-500 mt-1">
              Run a strategy against historical OHLCV data.
            </p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-3">
            <div>
              <label className="block text-xs text-gray-400 mb-1">Strategy</label>
              {strategies.length === 0 ? (
                <p className="text-sm text-gray-500">
                  No strategies yet —{" "}
                  <Link href="/copilot" className="text-blue-400 hover:underline">
                    create one in the Co-Pilot
                  </Link>
                </p>
              ) : (
                <select
                  value={form.strategy_id}
                  onChange={(e) => setForm({ ...form, strategy_id: e.target.value })}
                  className="w-full bg-gray-800 border border-gray-700 text-gray-100 text-sm rounded px-3 py-2"
                >
                  {strategies.map((s) => (
                    <option key={s.id} value={s.id}>{stratName(s)}</option>
                  ))}
                </select>
              )}
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-gray-400 mb-1">Pair</label>
                <select
                  value={form.pair}
                  onChange={(e) => setForm({ ...form, pair: e.target.value })}
                  className="w-full bg-gray-800 border border-gray-700 text-gray-100 text-sm rounded px-3 py-2"
                >
                  {PAIRS.map((p) => <option key={p}>{p}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs text-gray-400 mb-1">Timeframe</label>
                <select
                  value={form.timeframe}
                  onChange={(e) => setForm({ ...form, timeframe: e.target.value })}
                  className="w-full bg-gray-800 border border-gray-700 text-gray-100 text-sm rounded px-3 py-2"
                >
                  {TIMEFRAMES.map((t) => <option key={t}>{t}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs text-gray-400 mb-1">From</label>
                <input
                  type="date"
                  value={form.period_start}
                  onChange={(e) => setForm({ ...form, period_start: e.target.value })}
                  className="w-full bg-gray-800 border border-gray-700 text-gray-100 text-sm rounded px-3 py-2"
                />
              </div>
              <div>
                <label className="block text-xs text-gray-400 mb-1">To</label>
                <input
                  type="date"
                  value={form.period_end}
                  onChange={(e) => setForm({ ...form, period_end: e.target.value })}
                  className="w-full bg-gray-800 border border-gray-700 text-gray-100 text-sm rounded px-3 py-2"
                />
              </div>
            </div>

            <div>
              <label className="block text-xs text-gray-400 mb-1">Initial capital ($)</label>
              <input
                type="number"
                value={form.initial_capital}
                onChange={(e) => setForm({ ...form, initial_capital: e.target.value })}
                className="w-full bg-gray-800 border border-gray-700 text-gray-100 text-sm rounded px-3 py-2"
              />
            </div>

            <button
              type="submit"
              disabled={!form.strategy_id || !!jobId}
              className="w-full bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-sm font-medium rounded px-4 py-2 transition-colors"
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
          <div className="flex items-center justify-between">
            <h2 className="text-xs font-medium text-gray-500 uppercase tracking-wider">
              Recent runs
            </h2>
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
                    "group rounded-lg border transition-colors cursor-pointer",
                    selectedId === r.id
                      ? "border-blue-600 bg-blue-900/20"
                      : "border-gray-800 hover:border-gray-700 hover:bg-gray-800/50",
                  ].join(" ")}
                  onClick={() => setSelectedId(r.id)}
                >
                  <div className="px-3 py-2.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-medium text-gray-200">{r.pair}</span>
                      <span className="text-xs text-gray-500">{r.timeframe}</span>
                      <span className={`text-xs font-medium ml-auto ${r.total_pnl >= 0 ? "text-green-400" : "text-red-400"}`}>
                        {r.total_pnl >= 0 ? "+" : ""}${fmt(r.total_pnl, 0)}
                      </span>
                    </div>
                    <div className="flex items-center gap-3 mt-1 text-xs">
                      <span className="text-gray-300">Sh <span className="font-medium">{fmt(r.sharpe)}</span></span>
                      <span className="text-gray-300">WR <span className="font-medium">{fmtPct(r.win_rate)}</span></span>
                      <span className="text-gray-300">Tr <span className="font-medium">{r.trade_count ?? "—"}</span></span>
                    </div>
                    <div className="flex items-center justify-between mt-1">
                      <span className="text-[10px] text-gray-600">{r.period_start.slice(0, 10)} → {r.period_end.slice(0, 10)}</span>
                      <button
                        onClick={(e) => handleDeleteRun(r.id, e)}
                        className="opacity-0 group-hover:opacity-100 rounded border border-red-800 p-1 text-red-400 hover:bg-red-900/30 transition-all"
                        title="Delete this backtest"
                      >
                        <svg xmlns="http://www.w3.org/2000/svg" className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <polyline points="3 6 5 6 21 6" />
                          <path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6" />
                          <path d="M10 11v6M14 11v6" />
                          <path d="M9 6V4a1 1 0 011-1h4a1 1 0 011 1v2" />
                        </svg>
                      </button>
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
            onClose={() => setSelectedId(null)}
          />
        </div>
      ) : (
        <div className="flex-1 flex items-center justify-center text-sm text-gray-700 select-none">
          {history.length > 0 ? "← Select a run to view results" : ""}
        </div>
      )}
    </div>
  );
}
