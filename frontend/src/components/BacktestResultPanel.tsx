"use client";

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
import {
  conditionToLabel,
  exitConditionToLabel,
  filterToLabels,
  type EntryCondition,
  type ExitCondition,
} from "@/lib/strategyLabels";
import { computeHealthBadges } from "@/lib/strategyHealth";
import TradeAnalysisSidebar from "@/components/TradeAnalysisSidebar";

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

interface StrategyIrShape {
  entry_conditions?: EntryCondition[];
  exit_conditions?: {
    stop_loss?:   ExitCondition;
    take_profit?: ExitCondition;
  };
  filters?: { exclude_days?: string[]; session?: string };
  position_sizing?: { risk_per_trade_pct?: number; max_size_units?: number };
  metadata?: { description?: string };
}

interface Strategy {
  id: string;
  version: number;
  description: string;
  pair: string;
  timeframe: string;
  ir_json: StrategyIrShape;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const toTs = (iso: string): UTCTimestamp =>
  Math.floor(new Date(iso).getTime() / 1000) as UTCTimestamp;

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

function tradeDurationMin(t: Trade): number {
  return (new Date(t.exit_time).getTime() - new Date(t.entry_time).getTime()) / 60000;
}

// ---------------------------------------------------------------------------
// MetricCard
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
// ConditionCard
// ---------------------------------------------------------------------------
function ConditionCard({ text }: { text: string }) {
  return (
    <div className="rounded-md border border-slate-700 bg-slate-800/60 px-3 py-1.5 text-xs text-slate-200 leading-snug">
      {text}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------
interface Props {
  id: string;
  onClose?: () => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------
export default function BacktestResultPanel({ id, onClose }: Props) {
  const [result, setResult] = useState<BacktestResult | null>(null);
  const [equityCurve, setEquityCurve] = useState<EquityPoint[]>([]);
  const [candles, setCandles] = useState<
    { time: UTCTimestamp; open: number; high: number; low: number; close: number }[]
  >([]);
  const [indicatorData, setIndicatorData] = useState<IndicatorGroup[]>([]);
  const [strategy, setStrategy] = useState<Strategy | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tradeFilter, setTradeFilter] = useState<"all" | "long" | "short" | "win" | "loss">("all");
  const [sortCol, setSortCol] = useState<keyof Trade>("entry_time");
  const [sortAsc, setSortAsc] = useState(true);
  const [irView, setIrView] = useState<"story" | "json">("story");
  const [checkedTradeIds, setCheckedTradeIds] = useState<Set<string>>(new Set());
  const [selectPresetOpen, setSelectPresetOpen] = useState(false);
  const [tradeAnalysisOpen, setTradeAnalysisOpen] = useState(false);
  const selectAllRef = useRef<HTMLInputElement>(null);

  const chartContainerRef = useRef<HTMLDivElement>(null);
  const selectPresetRef = useRef<HTMLDivElement>(null);
  const oscContainerRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  // ---------------------------------------------------------------------------
  // Data fetch — resets fully when id changes
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (!id) return;

    setLoading(true);
    setResult(null);
    setEquityCurve([]);
    setCandles([]);
    setIndicatorData([]);
    setStrategy(null);
    setError(null);
    setTradeFilter("all");
    setIrView("story");
    setCheckedTradeIds(new Set());
    setTradeAnalysisOpen(false);

    Promise.all([
      fetchWithAuth(`/api/backtest/results/${id}`)
        .then((r) => { if (!r.ok) throw new Error("Not found"); return r.json(); }),
      fetchWithAuth(`/api/analytics/backtest/${id}/equity-curve`)
        .then((r) => r.ok ? r.json() : { points: [] }),
      fetchWithAuth(`/api/analytics/backtest/${id}/candles`)
        .then((r) => r.ok ? r.json() : { candles: [] }),
      fetchWithAuth(`/api/analytics/backtest/${id}/indicators`)
        .then(async (r) => {
          if (!r.ok) return { indicators: [] };
          return r.json();
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

        fetchWithAuth(`/api/strategies/${res.strategy_id}`)
          .then((r) => r.ok ? r.json() : null)
          .then((s: Strategy | null) => { if (s) setStrategy(s); })
          .catch(() => {});
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [id]);

  // Close preset dropdown on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (selectPresetRef.current && !selectPresetRef.current.contains(e.target as Node)) {
        setSelectPresetOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  // ---------------------------------------------------------------------------
  // Chart effect
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (!chartContainerRef.current || candles.length === 0 || !result) return;

    const container = chartContainerRef.current;
    const allCharts: IChartApi[] = [];

    const chart = createChart(container, {
      width: container.clientWidth,
      height: 360,
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

    const markers = result.trades
      .flatMap((t) => [
        { time: toTs(t.entry_time), position: "belowBar" as const, color: t.direction === "long" ? "#22c55e" : "#f97316", shape: "arrowUp" as const, text: "" },
        { time: toTs(t.exit_time), position: "aboveBar" as const, color: t.pnl >= 0 ? "#22c55e" : "#ef4444", shape: "arrowDown" as const, text: "" },
      ])
      .sort((a, b) => a.time - b.time);

    candleSeries.setMarkers(markers);

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

    const oscillators = indicatorData.filter((g) => g.pane === "oscillator");
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
        height: 100,
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

      if (firstSeries && group.levels) {
        group.levels.forEach((lv) => {
          (firstSeries!).createPriceLine({
            price: lv.value, color: lv.color, lineWidth: 1,
            lineStyle: LineStyle.Dashed, axisLabelVisible: false, title: "",
          });
        });
      }

      if (firstSeries) oscPairs.push({ chart: oscChart, el, firstSeries, timeToValue });
    });

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
        oscPairs.forEach(({ chart: c }) => { if (c !== oscChart) c.timeScale().setVisibleLogicalRange(range); });
        syncing = false;
      });
    });

    let crosshairSyncing = false;
    chart.subscribeCrosshairMove((param) => {
      if (crosshairSyncing) return;
      crosshairSyncing = true;
      oscPairs.forEach(({ chart: c, firstSeries: fs, timeToValue }) => {
        if (!param.time) { c.clearCrosshairPosition(); }
        else {
          const v = timeToValue.get(param.time as number);
          if (v !== undefined) c.setCrosshairPosition(v, param.time, fs);
          else c.clearCrosshairPosition();
        }
      });
      crosshairSyncing = false;
    });
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

    const handleResize = () => {
      chart.applyOptions({ width: container.clientWidth });
      oscPairs.forEach(({ chart: c, el }) => { c.applyOptions({ width: el.clientWidth }); });
    };
    window.addEventListener("resize", handleResize);

    return () => {
      window.removeEventListener("resize", handleResize);
      allCharts.forEach((c) => c.remove());
    };
  }, [candles, result, indicatorData]);

  // ---------------------------------------------------------------------------
  // Loading / error
  // ---------------------------------------------------------------------------
  if (loading) {
    return (
      <div className="space-y-4 animate-pulse">
        <div className="h-5 bg-gray-800 rounded w-40" />
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {Array.from({ length: 7 }).map((_, i) => (
            <div key={i} className="h-16 bg-gray-800 rounded-lg" />
          ))}
        </div>
        <div className="h-48 bg-gray-800 rounded-lg" />
      </div>
    );
  }

  if (error || !result) {
    return <p className="text-sm text-red-400">{error ?? "Backtest result not found."}</p>;
  }

  const m = result.metrics;

  // --- Compute profit factor + trade durations for health badges ---
  const winnerTrades = result.trades.filter((t) => t.pnl > 0);
  const loserTrades  = result.trades.filter((t) => t.pnl < 0);
  const grossProfit  = winnerTrades.reduce((s, t) => s + t.pnl, 0);
  const grossLoss    = Math.abs(loserTrades.reduce((s, t) => s + t.pnl, 0));
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : null;
  const avgWinDuration  = winnerTrades.length > 0
    ? winnerTrades.reduce((s, t) => s + tradeDurationMin(t), 0) / winnerTrades.length
    : null;
  const avgLossDuration = loserTrades.length > 0
    ? loserTrades.reduce((s, t) => s + tradeDurationMin(t), 0) / loserTrades.length
    : null;

  const healthBadges = computeHealthBadges(m, profitFactor, avgWinDuration, avgLossDuration);

  const badgeColours: Record<string, string> = {
    positive: "text-emerald-400 border-emerald-800 bg-emerald-900/20",
    neutral:  "text-yellow-400 border-yellow-800 bg-yellow-900/20",
    negative: "text-red-400 border-red-800 bg-red-900/20",
  };

  // --- Trade filtering + sorting ---
  const filtered = result.trades.filter((t) => {
    if (tradeFilter === "long")  return t.direction === "long";
    if (tradeFilter === "short") return t.direction === "short";
    if (tradeFilter === "win")   return t.pnl > 0;
    if (tradeFilter === "loss")  return t.pnl <= 0;
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

  // Outlier detection — 2σ below mean loss
  const lossValues = result.trades.filter((t) => t.pnl < 0).map((t) => t.pnl);
  const avgLossVal = lossValues.length > 0 ? lossValues.reduce((s, v) => s + v, 0) / lossValues.length : 0;
  const stdDevLoss = lossValues.length > 1
    ? Math.sqrt(lossValues.reduce((s, v) => s + (v - avgLossVal) ** 2, 0) / lossValues.length)
    : 0;
  const outlierThreshold = avgLossVal - 2 * stdDevLoss;
  const isOutlier = (t: Trade) => t.pnl < 0 && stdDevLoss > 0 && t.pnl < outlierThreshold;
  const outlierMultiple = (t: Trade) =>
    avgLossVal !== 0 ? Math.abs(t.pnl / avgLossVal).toFixed(1) : "?";

  // Select-all checkbox indeterminate state
  const visibleIds = sorted.slice(0, 200).map((t) => t.id);
  const checkedCount = visibleIds.filter((id) => checkedTradeIds.has(id)).length;
  const allChecked = visibleIds.length > 0 && checkedCount === visibleIds.length;
  const someChecked = checkedCount > 0 && checkedCount < visibleIds.length;
  if (selectAllRef.current) {
    selectAllRef.current.indeterminate = someChecked;
  }

  function toggleAll() {
    if (allChecked) {
      setCheckedTradeIds((prev) => {
        const next = new Set(prev);
        visibleIds.forEach((id) => next.delete(id));
        return next;
      });
    } else {
      setCheckedTradeIds((prev) => new Set([...prev, ...visibleIds]));
    }
  }

  function toggleTrade(id: string) {
    setCheckedTradeIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) { next.delete(id); } else { next.add(id); }
      return next;
    });
  }

  function applyPreset(preset: string) {
    setSelectPresetOpen(false);
    let ids: string[] = [];
    const all200 = sorted.slice(0, 200);
    if (preset === "losers")  ids = all200.filter((t) => t.pnl < 0).map((t) => t.id);
    else if (preset === "winners") ids = all200.filter((t) => t.pnl > 0).map((t) => t.id);
    else if (preset === "longs")   ids = all200.filter((t) => t.direction === "long").map((t) => t.id);
    else if (preset === "shorts")  ids = all200.filter((t) => t.direction === "short").map((t) => t.id);
    else if (preset === "outliers") ids = all200.filter(isOutlier).map((t) => t.id);
    else if (preset === "clear") { setCheckedTradeIds(new Set()); return; }
    setCheckedTradeIds(new Set(ids));
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
    <div className="space-y-5">

      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold text-gray-100">
            {result.pair} · {result.timeframe}
          </h2>
          <p className="text-xs text-gray-500 mt-0.5">
            {fmtDate(result.period_start)} — {fmtDate(result.period_end)} ·{" "}
            <span className="font-mono text-gray-600">{result.id.slice(0, 8)}</span>
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <a
            href={`/api/analytics/backtest/${id}/export-csv?token=${token}`}
            className="text-xs text-blue-400 hover:text-blue-300 border border-gray-700 rounded px-2.5 py-1"
          >
            Export CSV
          </a>
          {onClose && (
            <button
              onClick={onClose}
              className="text-xs text-gray-500 hover:text-gray-300 border border-gray-700 rounded px-2.5 py-1 transition-colors"
            >
              ✕
            </button>
          )}
        </div>
      </div>

      {/* Strategy info + indicator parameters */}
      {strategy && (() => {
        const ir = strategy.ir_json;
        const sl = ir.exit_conditions?.stop_loss;
        const tp = ir.exit_conditions?.take_profit;
        const filters = ir.filters;
        const sizing = ir.position_sizing;

        // Legacy chip helpers (used in JSON view)
        function stopLabel(s: ExitCondition | undefined): string {
          if (!s) return "—";
          if (s.type === "atr") return `ATR(${s.period}) × ${s.multiplier}`;
          if (s.type === "fixed_pips") return `${s.pips} pips`;
          if (s.type === "percent") return `${((s.percent ?? 0) * 100).toFixed(2)}%`;
          return s.type;
        }

        type Cond = NonNullable<typeof ir.entry_conditions>[number];

        function condParams(c: Cond): Array<{ key: string; val: string | number }> {
          const out: Array<{ key: string; val: string | number }> = [];
          const add = (k: string, v: string | number | null | undefined) => {
            if (v != null) out.push({ key: k, val: v });
          };
          if (c.indicator === "MACD") {
            add("fast", c.fast); add("slow", c.slow); add("sig", c.signal_period);
          } else {
            add("period", c.period);
          }
          add("std", c.std_dev);
          add("k", c.k_smooth);
          add("d", c.d_period);
          add("component", c.component);
          return out;
        }

        function condComparison(c: Cond) {
          if (c.operator === "price_above") return "price above";
          if (c.operator === "price_below") return "price below";
          if (c.value != null) return `${c.operator} ${c.value}`;
          return c.operator;
        }

        const Chip = ({ label, value }: { label: string; value: string | number }) => (
          <span className="inline-flex items-center gap-0.5 rounded bg-gray-700/70 px-1.5 py-0.5 text-[10px] font-mono leading-none">
            <span className="text-gray-500">{label}=</span>
            <span className="text-gray-200">{value}</span>
          </span>
        );

        const n = ir.entry_conditions?.length ?? 0;
        const cols = n <= 2 ? "grid-cols-1" : n <= 4 ? "grid-cols-2" : "grid-cols-3";

        return (
          <div className="bg-gray-800 rounded-lg px-3 py-2.5 space-y-2">

            {/* Header row + Story/JSON toggle */}
            <div className="flex items-center justify-between gap-3">
              <p className="text-xs font-medium text-gray-200 truncate">{strategy.description}</p>
              <div className="flex items-center gap-3 shrink-0">
                <div className="flex text-[10px]">
                  {(["story", "json"] as const).map((v) => (
                    <button
                      key={v}
                      onClick={() => setIrView(v)}
                      className={`px-2 py-0.5 capitalize transition-colors ${
                        irView === v
                          ? "text-blue-400 border-b border-blue-500"
                          : "text-slate-500 hover:text-slate-300"
                      }`}
                    >
                      {v}
                    </button>
                  ))}
                </div>
                <p className="text-[10px] text-gray-500 font-mono">
                  {strategy.pair} · {strategy.timeframe} · v{strategy.version}
                </p>
              </div>
            </div>

            {/* Entry conditions */}
            {ir.entry_conditions && ir.entry_conditions.length > 0 && (
              <div>
                <p className="text-[10px] uppercase tracking-widest text-slate-500 mb-1.5">Entry</p>
                {irView === "story" ? (
                  <div className={`grid ${cols} gap-2`}>
                    {ir.entry_conditions.map((c, i) => (
                      <ConditionCard key={i} text={conditionToLabel(c)} />
                    ))}
                  </div>
                ) : (
                  <div className={`grid ${cols} gap-x-4 gap-y-1`}>
                    {ir.entry_conditions.map((c, i) => {
                      const params = condParams(c);
                      return (
                        <div key={i} className="flex items-center gap-1.5 flex-wrap">
                          <span className="text-[10px] font-semibold text-blue-400 font-mono w-10 shrink-0">{c.indicator}</span>
                          {params.map(({ key, val }) => <Chip key={key} label={key} value={val} />)}
                          <span className="text-[10px] text-gray-400 italic">{condComparison(c)}</span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            {/* Exit + filters row */}
            {irView === "story" ? (
              <div className="flex flex-wrap gap-2 border-t border-gray-700/60 pt-1.5">
                {sl && <ConditionCard text={exitConditionToLabel("Stop Loss", sl)} />}
                {tp && <ConditionCard text={exitConditionToLabel("Take Profit", tp)} />}
                {filters && filterToLabels(filters).map((lbl, i) => (
                  <ConditionCard key={i} text={lbl} />
                ))}
                {sizing?.risk_per_trade_pct != null && (
                  <ConditionCard text={`Risk per trade: ${sizing.risk_per_trade_pct}%`} />
                )}
              </div>
            ) : (
              <div className="flex items-center gap-1.5 flex-wrap border-t border-gray-700/60 pt-1.5">
                {sl && (
                  <><span className="text-[10px] text-gray-400 mr-0.5">SL</span><span className="text-[10px] font-mono text-gray-300">{stopLabel(sl)}</span></>
                )}
                {tp && (
                  <><span className="text-[10px] text-gray-400 ml-1 mr-0.5">TP</span><span className="text-[10px] font-mono text-gray-300">{stopLabel(tp)}</span></>
                )}
                {sizing?.risk_per_trade_pct != null && (
                  <><span className="text-[10px] text-gray-400 ml-1 mr-0.5">risk</span><span className="text-[10px] font-mono text-gray-300">{sizing.risk_per_trade_pct}%</span></>
                )}
                {sizing?.max_size_units != null && (
                  <><span className="text-[10px] text-gray-400 ml-1 mr-0.5">size</span><span className="text-[10px] font-mono text-gray-300">{sizing.max_size_units.toLocaleString()}</span></>
                )}
                {filters?.session && filters.session !== "all" && (
                  <><span className="text-[10px] text-gray-400 ml-1 mr-0.5">session</span><span className="text-[10px] font-mono text-gray-300">{filters.session}</span></>
                )}
                {filters?.exclude_days && filters.exclude_days.length > 0 && (
                  <><span className="text-[10px] text-gray-400 ml-1 mr-0.5">excl</span><span className="text-[10px] font-mono text-gray-300">{filters.exclude_days.map(d => d.slice(0, 3)).join(",")}</span></>
                )}
              </div>
            )}
          </div>
        );
      })()}

      {/* Health Badges */}
      {healthBadges.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {healthBadges.map((b) => (
            <span
              key={b.label}
              className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-medium ${badgeColours[b.rating]}`}
            >
              <span className="text-slate-400">{b.label}:</span>
              <span>{b.value}</span>
            </span>
          ))}
        </div>
      )}

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
        <MetricCard label="Profit Factor" value={fmt(profitFactor)} />
      </div>

      {/* Candlestick chart */}
      {candles.length > 0 && (
        <div className="bg-gray-800 rounded-lg p-4">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-medium text-gray-300">Price Chart &amp; Trades</h3>
            <div className="flex items-center gap-4 text-xs text-gray-500 flex-wrap justify-end">
              <span className="flex items-center gap-1">
                <span className="w-2 h-2 rounded-full bg-green-500 inline-block" /> Winning
              </span>
              <span className="flex items-center gap-1">
                <span className="w-2 h-2 rounded-full bg-red-500 inline-block" /> Losing
              </span>
              {indicatorData.filter((g) => g.pane === "overlay").flatMap((g) => g.series).map((s) => (
                <span key={s.name} className="flex items-center gap-1">
                  <span className="inline-block w-5 h-0.5 rounded" style={{ backgroundColor: s.color }} />
                  {s.name}
                </span>
              ))}
            </div>
          </div>
          <div ref={chartContainerRef} className="w-full" />
          {oscillatorGroups.map((group) => (
            <div key={group.id} className="mt-px border-t border-gray-700">
              <div className="flex items-center gap-3 px-1 py-1">
                <span className="text-xs font-medium text-gray-500">{group.type}</span>
                {group.series.map((s) => (
                  <span key={s.name} className="flex items-center gap-1 text-xs text-gray-600">
                    <span className="inline-block w-4 h-0.5 rounded" style={{ backgroundColor: s.color }} />
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
          <h3 className="text-sm font-medium text-gray-300 mb-3">Equity Curve</h3>
          <ResponsiveContainer width="100%" height={180}>
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
              <Line type="monotone" dataKey="equity" stroke="#3b82f6" dot={false} strokeWidth={1.5} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Drawdown */}
      {ddPoints.length > 0 && (
        <div className="bg-gray-800 rounded-lg p-4">
          <h3 className="text-sm font-medium text-gray-300 mb-3">Drawdown (%)</h3>
          <ResponsiveContainer width="100%" height={110}>
            <AreaChart data={ddPoints}>
              <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
              <XAxis
                dataKey="time"
                tickFormatter={(v) => new Date(v).toLocaleDateString("en-GB", { month: "short", year: "2-digit" })}
                tick={{ fill: "#9ca3af", fontSize: 10 }}
                interval="preserveStartEnd"
              />
              <YAxis tickFormatter={(v) => `${v.toFixed(1)}%`} tick={{ fill: "#9ca3af", fontSize: 10 }} width={48} />
              <Tooltip
                contentStyle={{ background: "#1f2937", border: "1px solid #374151", borderRadius: 6 }}
                formatter={(v: number) => [`${v.toFixed(2)}%`, "Drawdown"]}
                labelFormatter={(v) => fmtDateTime(v)}
              />
              <Area type="monotone" dataKey="drawdown_pct" stroke="#ef4444" fill="#ef44441a" dot={false} strokeWidth={1.5} />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Trade table */}
      <div className="bg-gray-800 rounded-lg p-4">
        {/* Toolbar */}
        <div className="flex items-center justify-between mb-3 gap-2 flex-wrap">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-medium text-gray-300">Trades ({filtered.length})</h3>
            {checkedTradeIds.size > 0 && (
              <span className="text-xs text-blue-400">{checkedTradeIds.size} selected</span>
            )}
          </div>
          <div className="flex items-center gap-1 flex-wrap">
            {/* Filter buttons */}
            {(["all", "long", "short", "win", "loss"] as const).map((f) => (
              <button
                key={f}
                onClick={() => setTradeFilter(f)}
                className={`text-xs px-2 py-0.5 rounded ${
                  tradeFilter === f ? "bg-blue-700 text-white" : "text-gray-400 hover:text-gray-200"
                }`}
              >
                {f}
              </button>
            ))}
            {/* Select preset dropdown */}
            <div className="relative" ref={selectPresetRef}>
              <button
                onClick={() => setSelectPresetOpen((o) => !o)}
                className="rounded border border-slate-600 px-1.5 py-0.5 text-[10px] text-slate-400 hover:text-slate-200 hover:border-slate-400 transition-colors ml-1"
              >
                Select ▾
              </button>
              {selectPresetOpen && (
                <div className="absolute right-0 top-full mt-1 w-44 bg-slate-800 border border-slate-700 rounded shadow-lg z-20 py-1">
                  {[
                    ["losers",   "All losing trades"],
                    ["winners",  "All winning trades"],
                    ["longs",    "All long trades"],
                    ["shorts",   "All short trades"],
                    ["outliers", "Outlier losses (2σ)"],
                    ["clear",    "Clear selection"],
                  ].map(([key, label]) => (
                    <button
                      key={key}
                      onClick={() => applyPreset(key)}
                      className="w-full text-left px-3 py-1.5 text-xs text-slate-300 hover:bg-slate-700 transition-colors"
                    >
                      {label}
                    </button>
                  ))}
                </div>
              )}
            </div>
            {/* Analyze button */}
            <button
              onClick={() => setTradeAnalysisOpen(true)}
              disabled={checkedTradeIds.size < 2}
              className="rounded border border-blue-700 px-1.5 py-0.5 text-[10px] text-blue-400 hover:bg-blue-900/30 disabled:opacity-30 disabled:cursor-not-allowed transition-colors ml-1"
            >
              Analyze {checkedTradeIds.size > 0 ? checkedTradeIds.size : ""} trades
            </button>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-xs text-gray-300">
            <thead>
              <tr className="text-gray-500 border-b border-gray-700">
                {/* Checkbox column */}
                <th className="w-7 py-2 pr-2">
                  <input
                    ref={selectAllRef}
                    type="checkbox"
                    checked={allChecked}
                    onChange={toggleAll}
                    className="cursor-pointer accent-blue-500"
                  />
                </th>
                {(
                  [
                    ["entry_time",   "Entry"],
                    ["exit_time",    "Exit"],
                    ["direction",    "Dir"],
                    ["entry_price",  "Entry $"],
                    ["exit_price",   "Exit $"],
                    ["pnl",          "P&L"],
                    ["pnl_roi",      "ROI %"],
                    ["r_multiple",   "R"],
                    ["mae",          "MAE"],
                    ["mfe",          "MFE"],
                  ] as [string, string][]
                ).map(([col, label]) => (
                  <th
                    key={col}
                    onClick={() => toggleSort(col === "pnl_roi" ? "pnl" : col as keyof Trade)}
                    className="text-left py-2 pr-4 cursor-pointer hover:text-gray-200 select-none"
                  >
                    {label}{sortCol === (col === "pnl_roi" ? "pnl" : col) ? (sortAsc ? " ▲" : " ▼") : ""}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sorted.slice(0, 200).map((t) => {
                const checked = checkedTradeIds.has(t.id);
                const outlier = isOutlier(t);
                return (
                  <tr
                    key={t.id}
                    onClick={() => toggleTrade(t.id)}
                    className={`border-b border-gray-700/50 cursor-pointer transition-colors ${
                      checked
                        ? "border-blue-800 bg-blue-900/10"
                        : "hover:bg-gray-700/30"
                    }`}
                  >
                    <td className="py-1.5 pr-2" onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleTrade(t.id)}
                        className="cursor-pointer accent-blue-500"
                      />
                    </td>
                    <td className="py-1.5 pr-4">{fmtDateTime(t.entry_time)}</td>
                    <td className="pr-4">{fmtDateTime(t.exit_time)}</td>
                    <td className="pr-4">
                      <span className={`px-1.5 py-0.5 rounded text-xs font-medium ${t.direction === "long" ? "bg-green-900/40 text-green-400" : "bg-red-900/40 text-red-400"}`}>
                        {t.direction}
                      </span>
                    </td>
                    <td className="pr-4 font-mono">{t.entry_price.toFixed(5)}</td>
                    <td className="pr-4 font-mono">{t.exit_price.toFixed(5)}</td>
                    <td className={`pr-4 font-mono ${t.pnl >= 0 ? "text-green-400" : "text-red-400"}`}>
                      {outlier && (
                        <span
                          className="text-yellow-500 mr-1"
                          title={`Loss is ${outlierMultiple(t)}× larger than the average loss — worth investigating`}
                        >
                          ⚠
                        </span>
                      )}
                      {t.pnl >= 0 ? "+" : ""}${t.pnl.toFixed(0)}
                    </td>
                    <td className={`pr-4 font-mono ${t.pnl >= 0 ? "text-green-400" : "text-red-400"}`}>
                      {t.pnl >= 0 ? "+" : ""}{(t.pnl / 1000).toFixed(2)}%
                    </td>
                    <td className="pr-4 font-mono">{t.r_multiple.toFixed(2)}R</td>
                    <td className="pr-4 font-mono text-gray-500">{t.mae.toFixed(5)}</td>
                    <td className="font-mono text-gray-500">{t.mfe.toFixed(5)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {filtered.length > 200 && (
            <p className="text-xs text-gray-500 mt-2">
              Showing first 200 of {filtered.length} trades. Use Export CSV for all.
            </p>
          )}
        </div>
      </div>

      {/* Trade Analysis Sidebar */}
      {tradeAnalysisOpen && checkedTradeIds.size >= 2 && (
        <TradeAnalysisSidebar
          backtestRunId={result.id}
          tradeIds={[...checkedTradeIds]}
          onClose={() => setTradeAnalysisOpen(false)}
        />
      )}
    </div>
  );
}
