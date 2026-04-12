"use client";

import { useParams, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { fetchWithAuth, getAccessToken } from "@/lib/auth";
import {
  createChart,
  CrosshairMode,
  LineStyle,
  type IChartApi,
  type UTCTimestamp,
} from "lightweight-charts";
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
// Helpers
// ---------------------------------------------------------------------------
const toTs = (iso: string): UTCTimestamp =>
  Math.floor(new Date(iso).getTime() / 1000) as UTCTimestamp;

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

interface IndicatorSeries {
  name: string;
  color: string;
  data: { time: number; value: number }[];
}

interface LevelLine {
  value: number;
  color: string;
}

interface IndicatorGroup {
  id: string;
  type: string;
  pane: "overlay" | "oscillator";
  levels?: LevelLine[];
  series: IndicatorSeries[];
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
  useRouter();
  const [result, setResult] = useState<BacktestResult | null>(null);
  const [equityCurve, setEquityCurve] = useState<EquityPoint[]>([]);
  const [candles, setCandles] = useState<
    { time: UTCTimestamp; open: number; high: number; low: number; close: number }[]
  >([]);
  const [indicatorData, setIndicatorData] = useState<IndicatorGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tradeFilter, setTradeFilter] = useState<"all" | "long" | "short" | "win" | "loss">("all");
  const [sortCol, setSortCol] = useState<keyof Trade>("entry_time");
  const [sortAsc, setSortAsc] = useState(true);

  const chartContainerRef = useRef<HTMLDivElement>(null);
  // Map from oscillator group id → container element
  const oscContainerRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  // ---------------------------------------------------------------------------
  // Data fetch
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (!id) return;

    Promise.all([
      fetchWithAuth(`/api/backtest/results/${id}`)
        .then((r) => { if (!r.ok) throw new Error("Not found"); return r.json(); }),
      fetchWithAuth(`/api/analytics/backtest/${id}/equity-curve`)
        .then((r) => r.ok ? r.json() : { points: [] }),
      fetchWithAuth(`/api/analytics/backtest/${id}/candles`)
        .then((r) => r.ok ? r.json() : { candles: [] }),
      fetchWithAuth(`/api/analytics/backtest/${id}/indicators`)
        .then(async (r) => {
          if (!r.ok) {
            const body = await r.text().catch(() => "");
            console.error("[indicators] HTTP", r.status, body);
            return { indicators: [] };
          }
          return r.json();
        })
        .then((d) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const err = (d as any)?.error as string | undefined;
          if (err) console.error("[indicators] backend error:", err);
          console.log("[indicators] response:", JSON.stringify(d).slice(0, 500));
          return d;
        }),
    ])
      .then(([res, eq, candleData, indData]) => {
        setResult(res);
        setEquityCurve(eq.points ?? []);
        setCandles(
          (candleData.candles ?? []).map(
            (c: { time: number; open: number; high: number; low: number; close: number }) => ({
              ...c,
              time: c.time as UTCTimestamp,
            })
          )
        );
        setIndicatorData(indData.indicators ?? []);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [id]);

  // ---------------------------------------------------------------------------
  // Chart effect — main candlestick + overlays + oscillator panes
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (!chartContainerRef.current || candles.length === 0 || !result) return;

    const container = chartContainerRef.current;
    const allCharts: IChartApi[] = [];

    // ---- Main chart --------------------------------------------------------
    const chart = createChart(container, {
      width: container.clientWidth,
      height: 420,
      layout: { background: { color: "#111827" }, textColor: "#9ca3af" },
      grid: { vertLines: { color: "#1f2937" }, horzLines: { color: "#1f2937" } },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: "#374151" },
      timeScale: { borderColor: "#374151", timeVisible: true, secondsVisible: false },
    });
    allCharts.push(chart);

    const candleSeries = chart.addCandlestickSeries({
      upColor: "#22c55e",
      downColor: "#ef4444",
      borderVisible: false,
      wickUpColor: "#22c55e",
      wickDownColor: "#ef4444",
    });
    candleSeries.setData(candles);

    // ---- Overlay indicators (EMA, SMA, BB) ---------------------------------
    const overlays = indicatorData.filter((g) => g.pane === "overlay");
    overlays.forEach((group) => {
      group.series.forEach((s) => {
        const line = chart.addLineSeries({
          color: s.color,
          lineWidth: 1,
          lineStyle: LineStyle.Solid,
          priceLineVisible: false,
          lastValueVisible: true,
          crosshairMarkerVisible: false,
        });
        line.setData(s.data.map((d) => ({ time: d.time as UTCTimestamp, value: d.value })));
      });
    });

    // ---- Trade markers -----------------------------------------------------
    const markers = result.trades
      .flatMap((t) => [
        {
          time: toTs(t.entry_time),
          position: "belowBar" as const,
          color: t.direction === "long" ? "#22c55e" : "#f97316",
          shape: "arrowUp" as const,
          text: "",
        },
        {
          time: toTs(t.exit_time),
          position: "aboveBar" as const,
          color: t.pnl >= 0 ? "#22c55e" : "#ef4444",
          shape: "arrowDown" as const,
          text: "",
        },
      ])
      .sort((a, b) => a.time - b.time);

    candleSeries.setMarkers(markers);

    // One line series per trade: entry → exit coloured by outcome
    result.trades.forEach((t) => {
      const entryTs = toTs(t.entry_time);
      const exitTs = toTs(t.exit_time);
      if (entryTs === exitTs) return;
      const line = chart.addLineSeries({
        color: t.pnl >= 0 ? "#22c55e" : "#ef4444",
        lineWidth: 1,
        lineStyle: LineStyle.Solid,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
      });
      line.setData([
        { time: entryTs, value: t.entry_price },
        { time: exitTs, value: t.exit_price },
      ]);
    });

    chart.timeScale().fitContent();

    // ---- Oscillator panes --------------------------------------------------
    const oscillators = indicatorData.filter((g) => g.pane === "oscillator");

    // Build candle close lookup for crosshair sync (time → close price)
    const candleClose = new Map<number, number>();
    candles.forEach((c) => candleClose.set(c.time as number, c.close));

    type OscPair = {
      chart: IChartApi;
      el: HTMLDivElement;
      firstSeries: ReturnType<IChartApi["addLineSeries"]>;
      timeToValue: Map<number, number>;
    };
    const oscPairs: OscPair[] = [];

    oscillators.forEach((group) => {
      const el = oscContainerRefs.current.get(group.id);
      if (!el) return;

      const oscChart = createChart(el, {
        width: el.clientWidth,
        height: 120,
        layout: { background: { color: "#111827" }, textColor: "#9ca3af" },
        grid: { vertLines: { color: "#1f2937" }, horzLines: { color: "#1f2937" } },
        crosshair: { mode: CrosshairMode.Normal },
        rightPriceScale: { borderColor: "#374151" },
        timeScale: { borderColor: "#374151", timeVisible: true, secondsVisible: false, visible: false },
        leftPriceScale: { visible: false },
      });
      allCharts.push(oscChart);

      let firstSeries: ReturnType<typeof oscChart.addLineSeries> | null = null;
      const timeToValue = new Map<number, number>();

      group.series.forEach((s, i) => {
        const line = oscChart.addLineSeries({
          color: s.color,
          lineWidth: 1,
          lineStyle: LineStyle.Solid,
          priceLineVisible: false,
          lastValueVisible: true,
          crosshairMarkerVisible: true,
          title: s.name,
        });
        line.setData(s.data.map((d) => ({ time: d.time as UTCTimestamp, value: d.value })));
        if (i === 0) {
          firstSeries = line;
          s.data.forEach((d) => timeToValue.set(d.time, d.value));
        }
      });

      // Horizontal reference levels via createPriceLine
      if (firstSeries && group.levels) {
        group.levels.forEach((lv) => {
          (firstSeries!).createPriceLine({
            price: lv.value,
            color: lv.color,
            lineWidth: 1,
            lineStyle: LineStyle.Dashed,
            axisLabelVisible: false,
            title: "",
          });
        });
      }

      if (firstSeries) {
        oscPairs.push({ chart: oscChart, el, firstSeries, timeToValue });
      }
    });

    // ---- Sync time scales --------------------------------------------------
    let syncing = false;

    chart.timeScale().subscribeVisibleLogicalRangeChange((range) => {
      if (syncing || !range) return;
      syncing = true;
      oscPairs.forEach(({ chart: c }) => c.timeScale().setVisibleLogicalRange(range));
      syncing = false;
    });

    oscPairs.forEach(({ chart: oscChart }) => {
      oscChart.timeScale().subscribeVisibleLogicalRangeChange((range) => {
        if (syncing || !range) return;
        syncing = true;
        chart.timeScale().setVisibleLogicalRange(range);
        oscPairs.forEach(({ chart: c }) => {
          if (c !== oscChart) c.timeScale().setVisibleLogicalRange(range);
        });
        syncing = false;
      });
    });

    // ---- Sync crosshairs ---------------------------------------------------
    let crosshairSyncing = false;

    // Main chart → oscillators
    chart.subscribeCrosshairMove((param) => {
      if (crosshairSyncing) return;
      crosshairSyncing = true;
      oscPairs.forEach(({ chart: c, firstSeries: fs, timeToValue }) => {
        if (!param.time) {
          c.clearCrosshairPosition();
        } else {
          const v = timeToValue.get(param.time as number);
          if (v !== undefined) c.setCrosshairPosition(v, param.time, fs);
          else c.clearCrosshairPosition();
        }
      });
      crosshairSyncing = false;
    });

    // Each oscillator → main chart + other oscillators
    oscPairs.forEach(({ chart: oscChart }) => {
      oscChart.subscribeCrosshairMove((param) => {
        if (crosshairSyncing) return;
        crosshairSyncing = true;
        if (!param.time) {
          chart.clearCrosshairPosition();
          oscPairs.forEach(({ chart: c }) => { if (c !== oscChart) c.clearCrosshairPosition(); });
        } else {
          const t = param.time!;
          const close = candleClose.get(t as number);
          if (close !== undefined) chart.setCrosshairPosition(close, t, candleSeries);
          else chart.clearCrosshairPosition();
          oscPairs.forEach(({ chart: c, firstSeries: fs, timeToValue }) => {
            if (c === oscChart) return;
            const v = timeToValue.get(t as number);
            if (v !== undefined) c.setCrosshairPosition(v, t, fs);
            else c.clearCrosshairPosition();
          });
        }
        crosshairSyncing = false;
      });
    });

    // ---- Resize ------------------------------------------------------------
    const handleResize = () => {
      chart.applyOptions({ width: container.clientWidth });
      oscPairs.forEach(({ chart: c, el }) => {
        c.applyOptions({ width: el.clientWidth });
      });
    };
    window.addEventListener("resize", handleResize);

    return () => {
      window.removeEventListener("resize", handleResize);
      allCharts.forEach((c) => c.remove());
    };
  }, [candles, result, indicatorData]);

  // ---------------------------------------------------------------------------
  // Loading / error states
  // ---------------------------------------------------------------------------
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

  const token = getAccessToken() ?? "";

  const ddPoints = equityCurve.map((p) => ({
    time: p.time,
    drawdown_pct: +(p.drawdown * 100).toFixed(2),
  }));

  const oscillatorGroups = indicatorData.filter((g) => g.pane === "oscillator");

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------
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

      {/* Candlestick chart + indicator overlays + oscillator panes */}
      {candles.length > 0 && (
        <div className="bg-gray-800 rounded-lg p-4">
          {/* Legend row */}
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-medium text-gray-300">Price Chart &amp; Trades</h2>
            <div className="flex items-center gap-4 text-xs text-gray-500 flex-wrap justify-end">
              <span className="flex items-center gap-1">
                <span className="w-2 h-2 rounded-full bg-green-500 inline-block" />
                Winning trade
              </span>
              <span className="flex items-center gap-1">
                <span className="w-2 h-2 rounded-full bg-red-500 inline-block" />
                Losing trade
              </span>
              {indicatorData
                .filter((g) => g.pane === "overlay")
                .flatMap((g) => g.series)
                .map((s) => (
                  <span key={s.name} className="flex items-center gap-1">
                    <span
                      className="inline-block w-5 h-0.5 rounded"
                      style={{ backgroundColor: s.color }}
                    />
                    {s.name}
                  </span>
                ))}
            </div>
          </div>

          {/* Main chart */}
          <div ref={chartContainerRef} className="w-full" />

          {/* Oscillator panes below main chart */}
          {oscillatorGroups.map((group) => (
            <div key={group.id} className="mt-px border-t border-gray-700">
              <div className="flex items-center gap-3 px-1 py-1">
                <span className="text-xs font-medium text-gray-500">{group.type}</span>
                {group.series.map((s) => (
                  <span key={s.name} className="flex items-center gap-1 text-xs text-gray-600">
                    <span
                      className="inline-block w-4 h-0.5 rounded"
                      style={{ backgroundColor: s.color }}
                    />
                    {s.name}
                  </span>
                ))}
              </div>
              <div
                ref={(el) => {
                  if (el) oscContainerRefs.current.set(group.id, el);
                  else oscContainerRefs.current.delete(group.id);
                }}
                className="w-full"
              />
            </div>
          ))}
        </div>
      )}

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
