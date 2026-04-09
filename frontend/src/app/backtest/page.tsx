"use client";

import { useRouter } from "next/navigation";
import { FormEvent, useEffect, useRef, useState } from "react";

interface Strategy {
  id: string;
  created_at: string;
  ir: { metadata?: { name?: string; description?: string } };
}

interface JobStatus {
  status: string;
  progress_pct: number;
  result_id: string | null;
  error: string | null;
}

const PAIRS = ["EURUSD", "GBPUSD", "USDJPY", "EURGBP", "GBPJPY"];
const TIMEFRAMES = ["1m", "1H"];

export default function BacktestPage() {
  const router = useRouter();
  const [strategies, setStrategies] = useState<Strategy[]>([]);
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
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Load strategies on mount
  useEffect(() => {
    const token = localStorage.getItem("access_token");
    if (!token) return;
    fetch("/api/strategies", { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => r.json())
      .then((data) => {
        const list: Strategy[] = Array.isArray(data) ? data : data.strategies ?? [];
        setStrategies(list);
        if (list.length > 0) setForm((f) => ({ ...f, strategy_id: list[0].id }));
      })
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
    s.ir?.metadata?.name ?? s.ir?.metadata?.description?.slice(0, 40) ?? s.id.slice(0, 8);

  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-gray-100">Backtest</h1>
        <p className="text-sm text-gray-500 mt-1">
          Run a strategy against historical OHLCV data. Results stream in
          real-time and open automatically when complete.
        </p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
        {/* Strategy */}
        <div>
          <label className="block text-xs text-gray-400 mb-1">Strategy</label>
          {strategies.length === 0 ? (
            <p className="text-sm text-gray-500">
              No strategies yet —{" "}
              <a href="/copilot" className="text-blue-400 hover:underline">
                create one in the Co-Pilot
              </a>
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
          {/* Pair */}
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

          {/* Timeframe */}
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

          {/* Period start */}
          <div>
            <label className="block text-xs text-gray-400 mb-1">From</label>
            <input
              type="date"
              value={form.period_start}
              onChange={(e) => setForm({ ...form, period_start: e.target.value })}
              className="w-full bg-gray-800 border border-gray-700 text-gray-100 text-sm rounded px-3 py-2"
            />
          </div>

          {/* Period end */}
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

        {/* Initial capital */}
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

      {/* Progress */}
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
  );
}
