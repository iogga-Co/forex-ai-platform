"use client";

import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface Metrics {
  sharpe: number | null;
  sortino: number | null;
  max_dd: number | null;
  win_rate: number | null;
  avg_r: number | null;
  trade_count: number;
  total_pnl: number;
}

interface Trade {
  id: string;
  entry_time: string;
  exit_time: string;
  direction: "long" | "short";
  entry_price: number;
  exit_price: number;
  pnl: number;
  r_multiple: number;
  mae: number;
  mfe: number;
}

interface BacktestResult {
  id: string;
  strategy_id: string;
  pair: string;
  timeframe: string;
  period_start: string;
  period_end: string;
  metrics: Metrics;
  created_at: string;
  trades: Trade[];
}

interface EquityPoint {
  time: string;
  equity: number;
  cumulative_pnl: number;
  drawdown: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function fmt(v: number | null, decimals = 2): string {
  if (v === null || v === undefined) return "—";
  return v.toFixed(decimals);
}

function fmtPct(v: number | null): string {
  if (v === null || v === undefined) return "—";
  return (v * 100).toFixed(1) + "%";
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", {
    day: "2-digit", month: "short", year: "numeric",
  });
}

function fmtDateTime(iso: string): string {
  return new Date(iso).toLocaleString("en-GB", {
    day: "2-digit", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

// ---------------------------------------------------------------------------
// Metric card
// ---------------------------------------------------------------------------
function MetricCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="bg-gray-800 rounded-lg px-4 py-3">
      <p className="text-xs text-gray-400">{label}</p>
      <p className="text-xl font-semibold text-gray-100 mt-0.5">{value}</p>
      {sub && <p className="text-xs text-gray-500 mt-0.5">{sub}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------
export default function BacktestResultPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [result, setResult] = useState<BacktestResult | null>(null);
  const [equityCurve, setEquityCurve] = useState<EquityPoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tradeFilter, setTradeFilter] = useState<"all" | "long" | "short" | "win" | "loss">("all");
  const [sortCol, setSortCol] = useState<keyof Trade>("entry_time");
  const [sortAsc, setSortAsc] = useState(true);

  useEffect(() => {
    const token = localStorage.getItem("access_token");
    if (!id) return;
    if (!token) {
      router.push(`/login`);
      return;
    }

    Promise.all([
      fetch(`/api/backtest/results/${id}`, {
        headers: { Authorization: `Bearer ${token}` },
      }).then((r) => { if (!r.ok) throw new Error("Not found"); return r.json(); }),
      fetch(`/api/analytics/backtest/${id}/equity-curve`, {
        headers: { Authorization: `Bearer ${token}` },
      }).then((r) => r.ok ? r.json() : { points: [] }),
    ])
      .then(([res, eq]) => {
        setResult(res);
        setEquityCurve(eq.points ?? []);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [id]);

  if (loading) {
    return (
      <div className="space-y-4 animate-pulse">
        <div className="h-6 bg-gray-800 rounded w-48" />
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {Array.from({ length: 7 }).map((_, i) => (
            <div key={i} className="h-16 bg-gray-800 rounded-lg" />
          ))}
        </div>
        <div className="h-48 bg-gray-800 rounded-lg" />
      </div>
    );
  }

  if (error || !result) {
    return (
      <p className="text-sm text-red-400">
        {error ?? "Backtest result not found."}
      </p>
    );
  }

  const m = result.metrics;

  // Filtered & sorted trades
  const filtered = result.trades.filter((t) => {
    if (tradeFilter === "long") return t.direction === "long";
    if (tradeFilter === "short") return t.direction === "short";
    if (tradeFilter === "win") return t.pnl > 0;
    if (tradeFilter === "loss") return t.pnl <= 0;
    return true;
  });

  const sorted = [...filtered].sort((a, b) => {
    const av = a[sortCol];
    const bv = b[sortCol];
    if (av === bv) return 0;
    const cmp = av < bv ? -1 : 1;
    return sortAsc ? cmp : -cmp;
  });

  function toggleSort(col: keyof Trade) {
    if (col === sortCol) setSortAsc(!sortAsc);
    else { setSortCol(col); setSortAsc(true); }
  }

  const token = typeof window !== "undefined" ? localStorage.getItem("access_token") : "";

  // Drawdown in percent for chart
  const ddPoints = equityCurve.map((p) => ({
    time: p.time,
    drawdown_pct: +(p.drawdown * 100).toFixed(2),
  }));

  return (
    <div className="space-y-6 max-w-6xl">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-xl font-semibold text-gray-100">
            {result.pair} · {result.timeframe}
          </h1>
          <p className="text-sm text-gray-500 mt-0.5">
            {fmtDate(result.period_start)} — {fmtDate(result.period_end)} ·{" "}
            <span className="font-mono text-xs text-gray-600">{result.id.slice(0, 8)}</span>
          </p>
        </div>
        <a
          href={`/api/analytics/backtest/${id}/export-csv?token=${token}`}
          className="text-xs text-blue-400 hover:text-blue-300 border border-gray-700 rounded px-3 py-1.5"
        >
          Export CSV
        </a>
      </div>

      {/* Metric cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <MetricCard label="Sharpe" value={fmt(m.sharpe)} />
        <MetricCard label="Sortino" value={fmt(m.sortino)} />
        <MetricCard label="Max Drawdown" value={fmtPct(m.max_dd)} />
        <MetricCard label="Win Rate" value={fmtPct(m.win_rate)} />
        <MetricCard label="Avg R-Multiple" value={fmt(m.avg_r)} />
        <MetricCard label="Trades" value={String(m.trade_count)} />
        <MetricCard
          label="Total P&L"
          value={`$${m.total_pnl.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`}
          sub={m.total_pnl >= 0 ? "profit" : "loss"}
        />
      </div>

      {/* Equity curve */}
      {equityCurve.length > 0 && (
        <div className="bg-gray-800 rounded-lg p-4">
          <h2 className="text-sm font-medium text-gray-300 mb-3">Equity Curve</h2>
          <ResponsiveContainer width="100%" height={200}>
            <LineChart data={equityCurve}>
              <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
              <XAxis
                dataKey="time"
                tickFormatter={(v) => new Date(v).toLocaleDateString("en-GB", { month: "short", year: "2-digit" })}
                tick={{ fill: "#9ca3af", fontSize: 10 }}
                interval="preserveStartEnd"
              />
              <YAxis
                tickFormatter={(v) => `$${(v / 1000).toFixed(0)}k`}
                tick={{ fill: "#9ca3af", fontSize: 10 }}
                width={52}
              />
              <Tooltip
                contentStyle={{ background: "#1f2937", border: "1px solid #374151", borderRadius: 6 }}
                labelStyle={{ color: "#9ca3af", fontSize: 11 }}
                itemStyle={{ color: "#60a5fa" }}
                formatter={(v: number) => [`$${v.toLocaleString()}`, "Equity"]}
                labelFormatter={(v) => fmtDateTime(v)}
              />
              <Line
                type="monotone"
                dataKey="equity"
                stroke="#3b82f6"
                dot={false}
                strokeWidth={1.5}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Drawdown */}
      {ddPoints.length > 0 && (
        <div className="bg-gray-800 rounded-lg p-4">
          <h2 className="text-sm font-medium text-gray-300 mb-3">Drawdown (%)</h2>
          <ResponsiveContainer width="100%" height={120}>
            <AreaChart data={ddPoints}>
              <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
              <XAxis
                dataKey="time"
                tickFormatter={(v) => new Date(v).toLocaleDateString("en-GB", { month: "short", year: "2-digit" })}
                tick={{ fill: "#9ca3af", fontSize: 10 }}
                interval="preserveStartEnd"
              />
              <YAxis
                tickFormatter={(v) => `${v.toFixed(1)}%`}
                tick={{ fill: "#9ca3af", fontSize: 10 }}
                width={48}
              />
              <Tooltip
                contentStyle={{ background: "#1f2937", border: "1px solid #374151", borderRadius: 6 }}
                formatter={(v: number) => [`${v.toFixed(2)}%`, "Drawdown"]}
                labelFormatter={(v) => fmtDateTime(v)}
              />
              <Area
                type="monotone"
                dataKey="drawdown_pct"
                stroke="#ef4444"
                fill="#ef44441a"
                dot={false}
                strokeWidth={1.5}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Trade table */}
      <div className="bg-gray-800 rounded-lg p-4">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-medium text-gray-300">
            Trades ({filtered.length})
          </h2>
          <div className="flex gap-1">
            {(["all", "long", "short", "win", "loss"] as const).map((f) => (
              <button
                key={f}
                onClick={() => setTradeFilter(f)}
                className={`text-xs px-2 py-0.5 rounded ${
                  tradeFilter === f
                    ? "bg-blue-700 text-white"
                    : "text-gray-400 hover:text-gray-200"
                }`}
              >
                {f}
              </button>
            ))}
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-xs text-gray-300">
            <thead>
              <tr className="text-gray-500 border-b border-gray-700">
                {(
                  [
                    ["entry_time", "Entry"],
                    ["exit_time", "Exit"],
                    ["direction", "Dir"],
                    ["entry_price", "Entry $"],
                    ["exit_price", "Exit $"],
                    ["pnl", "P&L"],
                    ["r_multiple", "R"],
                    ["mae", "MAE"],
                    ["mfe", "MFE"],
                  ] as [keyof Trade, string][]
                ).map(([col, label]) => (
                  <th
                    key={col}
                    onClick={() => toggleSort(col)}
                    className="text-left py-2 pr-4 cursor-pointer hover:text-gray-200 select-none"
                  >
                    {label}
                    {sortCol === col ? (sortAsc ? " ▲" : " ▼") : ""}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sorted.slice(0, 200).map((t) => (
                <tr
                  key={t.id}
                  className="border-b border-gray-700/50 hover:bg-gray-700/30"
                >
                  <td className="py-1.5 pr-4">{fmtDateTime(t.entry_time)}</td>
                  <td className="pr-4">{fmtDateTime(t.exit_time)}</td>
                  <td className="pr-4">
                    <span
                      className={`px-1.5 py-0.5 rounded text-xs font-medium ${
                        t.direction === "long"
                          ? "bg-green-900/40 text-green-400"
                          : "bg-red-900/40 text-red-400"
                      }`}
                    >
                      {t.direction}
                    </span>
                  </td>
                  <td className="pr-4 font-mono">{t.entry_price.toFixed(5)}</td>
                  <td className="pr-4 font-mono">{t.exit_price.toFixed(5)}</td>
                  <td
                    className={`pr-4 font-mono ${
                      t.pnl >= 0 ? "text-green-400" : "text-red-400"
                    }`}
                  >
                    {t.pnl >= 0 ? "+" : ""}${t.pnl.toFixed(0)}
                  </td>
                  <td className="pr-4 font-mono">{t.r_multiple.toFixed(2)}R</td>
                  <td className="pr-4 font-mono text-gray-500">{t.mae.toFixed(5)}</td>
                  <td className="font-mono text-gray-500">{t.mfe.toFixed(5)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {filtered.length > 200 && (
            <p className="text-xs text-gray-500 mt-2">
              Showing first 200 of {filtered.length} trades. Use Export CSV for all.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
