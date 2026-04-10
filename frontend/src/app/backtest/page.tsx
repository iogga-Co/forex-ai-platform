"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, useEffect, useRef, useState } from "react";

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

export default function BacktestPage() {
  const router = useRouter();
  const [strategies, setStrategies] = useState<Strategy[]>([]);
  const [history, setHistory] = useState<RunSummary[]>([]);
  const [form, setForm] = useState({
    strategy_id: "",
    pair: "EURUSD",
    timeframe: "1H",
    period_start: "2022-01-01",
    period_end: "2024-01-01",
    initial_capital: "100000",
  });
  const [jobId, setJobId] = useState<string | null>(null);
  const [jobStatus, setJobStatus] = useState<JobStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notLoggedIn, setNotLoggedIn] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Load strategies and history on mount
  useEffect(() => {
    const token = localStorage.getItem("access_token");
    if (!token) {
      setNotLoggedIn(true);
      return;
    }
    const headers = { Authorization: `Bearer ${token}` };

    fetch("/api/strategies", { headers })
      .then((r) => r.json())
      .then((data) => {
        const list: Strategy[] = Array.isArray(data) ? data : data.strategies ?? [];
        setStrategies(list);
        if (list.length > 0) setForm((f) => ({ ...f, strategy_id: list[0].id }));
      })
      .catch(() => {});

    fetch("/api/backtest/results?limit=20", { headers })
      .then((r) => r.json())
      .then((data: RunSummary[]) => setHistory(Array.isArray(data) ? data : []))
      .catch(() => {});
  }, []);

  // Poll job status
  useEffect(() => {
    if (!jobId) return;
    const token = localStorage.getItem("access_token");
    pollRef.current = setInterval(async () => {
      try {
        const res = await fetch(`/api/backtest/jobs/${jobId}/status`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const data: JobStatus = await res.json();
        setJobStatus(data);
        if (data.status === "complete" && data.result_id) {
          clearInterval(pollRef.current!);
          router.push(`/backtest/results/${data.result_id}`);
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
  }, [jobId, router]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setJobId(null);
    setJobStatus(null);
    const token = localStorage.getItem("access_token");
    const sessionId = crypto.randomUUID();
    try {
      const res = await fetch(`/api/backtest?session_id=${sessionId}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
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
    s.ir_json?.metadata?.name ?? s.ir_json?.metadata?.description?.slice(0, 40) ?? s.id.slice(0, 8);

  if (notLoggedIn) {
    return (
      <div className="max-w-2xl space-y-4">
        <h1 className="text-xl font-semibold text-gray-100">Backtest</h1>
        <p className="text-sm text-gray-400">
          You need to{" "}
          <Link href="/login" className="text-blue-400 hover:underline">
            sign in
          </Link>{" "}
          to run backtests.
        </p>
      </div>
    );
  }

  return (
    <div className="max-w-3xl space-y-8">
      {/* ---- Form ---- */}
      <div className="space-y-4">
        <div>
          <h1 className="text-xl font-semibold text-gray-100">Backtest</h1>
          <p className="text-sm text-gray-500 mt-1">
            Run a strategy against historical OHLCV data. Results open automatically when complete.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Strategy */}
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
                  <option key={s.id} value={s.id}>
                    {stratName(s)}
                  </option>
                ))}
              </select>
            )}
          </div>

          <div className="grid grid-cols-2 gap-4">
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
            className="w-full bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-sm font-medium rounded px-4 py-2"
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

      {/* ---- History ---- */}
      <div className="space-y-3">
        <h2 className="text-sm font-medium text-gray-300">Recent runs</h2>
        {history.length === 0 ? (
          <p className="text-sm text-gray-500">No completed backtests yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-gray-500 border-b border-gray-800">
                  <th className="text-left pb-2 font-normal">Date</th>
                  <th className="text-left pb-2 font-normal">Pair</th>
                  <th className="text-left pb-2 font-normal">TF</th>
                  <th className="text-left pb-2 font-normal">Period</th>
                  <th className="text-right pb-2 font-normal">Sharpe</th>
                  <th className="text-right pb-2 font-normal">Max DD</th>
                  <th className="text-right pb-2 font-normal">Win%</th>
                  <th className="text-right pb-2 font-normal">Trades</th>
                  <th className="text-right pb-2 font-normal">P&amp;L</th>
                  <th className="pb-2" />
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-800">
                {history.map((r) => (
                  <tr key={r.id} className="hover:bg-gray-800/50 transition-colors">
                    <td className="py-2 pr-4 text-gray-400 whitespace-nowrap">
                      {fmtDate(r.created_at)}
                    </td>
                    <td className="py-2 pr-4 text-gray-200">{r.pair}</td>
                    <td className="py-2 pr-4 text-gray-400">{r.timeframe}</td>
                    <td className="py-2 pr-4 text-gray-500 whitespace-nowrap text-xs">
                      {r.period_start.slice(0, 10)} → {r.period_end.slice(0, 10)}
                    </td>
                    <td className="py-2 pr-4 text-right text-gray-200">{fmt(r.sharpe)}</td>
                    <td className="py-2 pr-4 text-right text-red-400">{fmtPct(r.max_dd)}</td>
                    <td className="py-2 pr-4 text-right text-gray-200">{fmtPct(r.win_rate)}</td>
                    <td className="py-2 pr-4 text-right text-gray-400">{r.trade_count}</td>
                    <td className={`py-2 pr-4 text-right font-medium ${r.total_pnl >= 0 ? "text-green-400" : "text-red-400"}`}>
                      {r.total_pnl >= 0 ? "+" : ""}{fmt(r.total_pnl)}
                    </td>
                    <td className="py-2 text-right">
                      <Link
                        href={`/backtest/results/${r.id}`}
                        className="text-blue-400 hover:underline text-xs"
                      >
                        View →
                      </Link>
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
