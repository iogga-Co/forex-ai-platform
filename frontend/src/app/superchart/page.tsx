"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  createChart,
  CrosshairMode,
  IChartApi,
  ISeriesApi,
  LineStyle,
  LineWidth,
  Time,
} from "lightweight-charts";
import { fetchWithAuth } from "@/lib/auth";
import {
  ema, sma, rsi, macd, bollingerBands, atr, adx, stochastic,
  toChartData, Series,
} from "@/lib/indicators";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

interface Trade {
  id: string;
  entry_time: string;
  exit_time: string;
  direction: string;
  entry_price: number;
  exit_price: number;
  pnl: number;
}

interface IndicatorCondition {
  indicator: string;
  period: number;
  operator: string;
  value?: number | null;
  component?: string | null;
  fast?: number | null;
  slow?: number | null;
  signal_period?: number | null;
  std_dev?: number | null;
  k_smooth?: number | null;
  d_period?: number | null;
}

interface StrategyIR {
  entry_conditions: IndicatorCondition[];
  exit_conditions: {
    stop_loss?: { type: string; period?: number; multiplier?: number };
    take_profit?: { type: string; period?: number; multiplier?: number };
  };
  filters?: unknown;
  position_sizing?: unknown;
  metadata?: { description?: string };
}

interface Strategy {
  id: string;
  description: string;
  pair: string;
  timeframe: string;
  version: number;
  ir_json: StrategyIR;
}

interface BacktestResult {
  id: string;
  strategy_id: string;
  pair: string;
  timeframe: string;
  period_start: string;
  period_end: string;
  sharpe: number | null;
  win_rate: number | null;
  trade_count: number | null;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "";
const PAIRS = ["EURUSD", "GBPUSD", "USDJPY", "EURGBP", "GBPJPY", "USDCHF"];
const TIMEFRAMES = ["1m", "1H"];

const CHART_THEME = {
  background: "#09090b",
  text: "#a1a1aa",
  grid: "#1c1c1f",
  border: "#27272a",
  upColor: "#22c55e",
  downColor: "#ef4444",
};

const OVERLAY_COLORS = ["#3b82f6", "#f59e0b", "#a855f7", "#06b6d4", "#f97316"];
const OSC_COLORS = { rsi: "#06b6d4", macdLine: "#3b82f6", macdSig: "#f97316", macdHist: "#6b7280", adx: "#a855f7", stochK: "#22d3ee", stochD: "#f97316", atr: "#94a3b8" };

type OscTab = "RSI" | "MACD" | "ADX" | "STOCH" | "ATR";

function defaultDateFrom() {
  const d = new Date();
  d.setFullYear(d.getFullYear() - 1);
  return d.toISOString().slice(0, 10);
}
function defaultDateTo() {
  return new Date().toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Chart factory
// ---------------------------------------------------------------------------
function makeChart(container: HTMLDivElement, height: number, hideTimeScale = false): IChartApi {
  return createChart(container, {
    width: container.clientWidth,
    height,
    layout: { background: { color: CHART_THEME.background }, textColor: CHART_THEME.text },
    grid: { vertLines: { color: CHART_THEME.grid }, horzLines: { color: CHART_THEME.grid } },
    crosshair: { mode: CrosshairMode.Normal },
    rightPriceScale: { borderColor: CHART_THEME.border },
    timeScale: {
      borderColor: CHART_THEME.border,
      timeVisible: true,
      secondsVisible: false,
      visible: !hideTimeScale,
    },
  });
}

// ---------------------------------------------------------------------------
// Main page component
// ---------------------------------------------------------------------------
export default function SuperchartPage() {
  return (
    <Suspense>
      <SuperchartPageInner />
    </Suspense>
  );
}

function SuperchartPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();

  // --- data controls ---
  const [pair, setPair] = useState("EURUSD");
  const [timeframe, setTimeframe] = useState("1H");
  const [dateFrom, setDateFrom] = useState(defaultDateFrom);
  const [dateTo, setDateTo] = useState(defaultDateTo);

  // --- loaded data ---
  const [candles, setCandles] = useState<Candle[]>([]);
  const [strategies, setStrategies] = useState<Strategy[]>([]);
  const [selectedStratId, setSelectedStratId] = useState<string>("");
  const [backtests, setBacktests] = useState<BacktestResult[]>([]);
  const [selectedBtId, setSelectedBtId] = useState<string>("");
  const [trades, setTrades] = useState<Trade[]>([]);

  // --- strategy IR (editable copy) ---
  const [currentSIR, setCurrentSIR] = useState<StrategyIR | null>(null);
  const [originalSIR, setOriginalSIR] = useState<StrategyIR | null>(null);

  // --- UI state ---
  const [loadingCandles, setLoadingCandles] = useState(false);
  const [activeOsc, setActiveOsc] = useState<OscTab>("RSI");
  const [savingDraft, setSavingDraft] = useState(false);
  const [draftError, setDraftError] = useState("");

  // --- chart refs ---
  const mainDivRef = useRef<HTMLDivElement>(null);
  const subDivRef = useRef<HTMLDivElement>(null);
  const mainChartRef = useRef<IChartApi | null>(null);
  const subChartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const overlaySeriesRef = useRef<ISeriesApi<"Line">[]>([]);
  const subSeriesRef = useRef<ISeriesApi<"Line" | "Histogram">[]>([]);
  const syncingRef = useRef(false);          // prevent feedback loops during scroll sync
  const crosshairSyncRef = useRef(false);    // prevent feedback loops during crosshair sync

  // ---------------------------------------------------------------------------
  // Chart initialisation (once on mount)
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (!mainDivRef.current || !subDivRef.current) return;

    const main = makeChart(mainDivRef.current, mainDivRef.current.clientHeight);
    const sub = makeChart(subDivRef.current, subDivRef.current.clientHeight, false);

    const cSeries = main.addCandlestickSeries({
      upColor: CHART_THEME.upColor,
      downColor: CHART_THEME.downColor,
      borderUpColor: CHART_THEME.upColor,
      borderDownColor: CHART_THEME.downColor,
      wickUpColor: CHART_THEME.upColor,
      wickDownColor: CHART_THEME.downColor,
    });

    mainChartRef.current = main;
    subChartRef.current = sub;
    candleSeriesRef.current = cSeries;

    // Synchronise scroll/zoom between the two charts
    main.timeScale().subscribeVisibleLogicalRangeChange((range) => {
      if (syncingRef.current || !range) return;
      syncingRef.current = true;
      sub.timeScale().setVisibleLogicalRange(range);
      syncingRef.current = false;
    });
    sub.timeScale().subscribeVisibleLogicalRangeChange((range) => {
      if (syncingRef.current || !range) return;
      syncingRef.current = true;
      main.timeScale().setVisibleLogicalRange(range);
      syncingRef.current = false;
    });

    // Synchronise crosshair between the two charts
    main.subscribeCrosshairMove((param) => {
      if (crosshairSyncRef.current) return;
      crosshairSyncRef.current = true;
      const subSeries = subSeriesRef.current[0];
      if (!param.time || !subSeries) {
        sub.clearCrosshairPosition();
      } else {
        sub.setCrosshairPosition(NaN, param.time, subSeries);
      }
      crosshairSyncRef.current = false;
    });
    sub.subscribeCrosshairMove((param) => {
      if (crosshairSyncRef.current) return;
      crosshairSyncRef.current = true;
      if (!param.time || !cSeries) {
        main.clearCrosshairPosition();
      } else {
        main.setCrosshairPosition(NaN, param.time, cSeries);
      }
      crosshairSyncRef.current = false;
    });

    // Resize observer
    const ro = new ResizeObserver(() => {
      if (mainDivRef.current) main.applyOptions({ width: mainDivRef.current.clientWidth });
      if (subDivRef.current) sub.applyOptions({ width: subDivRef.current.clientWidth });
    });
    if (mainDivRef.current) ro.observe(mainDivRef.current);
    if (subDivRef.current) ro.observe(subDivRef.current);

    return () => {
      ro.disconnect();
      main.remove();
      sub.remove();
      mainChartRef.current = null;
      subChartRef.current = null;
      candleSeriesRef.current = null;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------------------------------------------------------------------------
  // Load strategies on mount
  // ---------------------------------------------------------------------------
  useEffect(() => {
    fetchWithAuth(`${API_BASE}/api/strategies`)
      .then((r) => r.json())
      .then((data: Strategy[]) => {
        setStrategies(data);
        const urlStratId = searchParams.get("strategy_id");
        const initial = urlStratId && data.find((s) => s.id === urlStratId)
          ? urlStratId
          : data.length > 0 ? data[0].id : "";
        setSelectedStratId(initial);
      })
      .catch(() => {});
  }, []);

  // ---------------------------------------------------------------------------
  // Load candles when pair / timeframe / dates change
  // ---------------------------------------------------------------------------
  const loadCandles = useCallback(async (
    p: string, tf: string, from: string, to: string,
  ) => {
    setLoadingCandles(true);
    try {
      const url = `${API_BASE}/api/candles?pair=${p}&timeframe=${tf}&start=${from}&end=${to}&limit=5000`;
      const res = await fetchWithAuth(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setCandles(data.candles ?? []);
    } catch {
      setCandles([]);
    } finally {
      setLoadingCandles(false);
    }
  }, []);

  useEffect(() => {
    if (dateFrom && dateTo) loadCandles(pair, timeframe, dateFrom, dateTo);
  }, [pair, timeframe, dateFrom, dateTo, loadCandles]);

  // ---------------------------------------------------------------------------
  // Load strategy SIR and backtests when strategy selection changes
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (!selectedStratId) return;
    const strat = strategies.find((s) => s.id === selectedStratId);
    if (strat) {
      const sir = JSON.parse(JSON.stringify(strat.ir_json)) as StrategyIR;
      setCurrentSIR(sir);
      setOriginalSIR(JSON.parse(JSON.stringify(sir)));
    }
    // Load backtests for this strategy
    fetchWithAuth(`${API_BASE}/api/backtest/results?strategy_id=${selectedStratId}&limit=50`)
      .then((r) => r.json())
      .then((data: BacktestResult[]) => {
        setBacktests(data);
        const urlBtId = searchParams.get("backtest_id");
        const initial = urlBtId && data.find((b) => b.id === urlBtId) ? urlBtId : "";
        setSelectedBtId(initial);
        setTrades([]);
      })
      .catch(() => {});
  }, [selectedStratId, strategies]);

  // ---------------------------------------------------------------------------
  // Load trades when backtest selection changes
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (!selectedBtId) {
      setTrades([]);
      return;
    }
    const bt = backtests.find((b) => b.id === selectedBtId);
    if (bt) {
      // Sync chart date range to backtest period
      setPair(bt.pair);
      setTimeframe(bt.timeframe);
      setDateFrom(bt.period_start.slice(0, 10));
      setDateTo(bt.period_end.slice(0, 10));
    }
    fetchWithAuth(`${API_BASE}/api/backtest/results/${selectedBtId}`)
      .then((r) => r.json())
      .then((data) => setTrades(data.trades ?? []))
      .catch(() => {});
  }, [selectedBtId, backtests]);

  // ---------------------------------------------------------------------------
  // Update candlestick series whenever candles change
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (!candleSeriesRef.current || candles.length === 0) return;
    candleSeriesRef.current.setData(
      candles.map((c) => ({
        time: c.time as Time,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
      })),
    );
    mainChartRef.current?.timeScale().fitContent();
  }, [candles]);

  // ---------------------------------------------------------------------------
  // Recompute and render indicator series whenever candles or SIR change
  // ---------------------------------------------------------------------------
  useEffect(() => {
    const main = mainChartRef.current;
    const sub = subChartRef.current;
    if (!main || !sub || candles.length === 0) return;

    // Clear previous overlay + sub series
    overlaySeriesRef.current.forEach((s) => main.removeSeries(s));
    overlaySeriesRef.current = [];
    subSeriesRef.current.forEach((s) => sub.removeSeries(s));
    subSeriesRef.current = [];

    if (!currentSIR) return;

    const times = candles.map((c) => c.time);
    const closes = candles.map((c) => c.close);
    const highs = candles.map((c) => c.high);
    const lows = candles.map((c) => c.low);

    let overlayColorIdx = 0;

    for (const cond of currentSIR.entry_conditions) {
      const ind = cond.indicator.toUpperCase();

      if (ind === "EMA") {
        const data = toChartData(times, ema(closes, cond.period));
        const color = OVERLAY_COLORS[overlayColorIdx++ % OVERLAY_COLORS.length];
        const s = main.addLineSeries({ color, lineWidth: 1 as LineWidth, priceLineVisible: false, lastValueVisible: false, title: `EMA ${cond.period}` });
        s.setData(data as { time: Time; value: number }[]);
        overlaySeriesRef.current.push(s);

      } else if (ind === "SMA") {
        const data = toChartData(times, sma(closes, cond.period));
        const color = OVERLAY_COLORS[overlayColorIdx++ % OVERLAY_COLORS.length];
        const s = main.addLineSeries({ color, lineWidth: 1 as LineWidth, lineStyle: LineStyle.Dashed, priceLineVisible: false, lastValueVisible: false, title: `SMA ${cond.period}` });
        s.setData(data as { time: Time; value: number }[]);
        overlaySeriesRef.current.push(s);

      } else if (ind === "BB") {
        const p = cond.period ?? 20;
        const sd = cond.std_dev ?? 2.0;
        const { upper, middle, lower } = bollingerBands(closes, p, sd);
        const color = OVERLAY_COLORS[overlayColorIdx++ % OVERLAY_COLORS.length];
        const opts = { color, lineWidth: 1 as LineWidth, priceLineVisible: false, lastValueVisible: false };
        const su = main.addLineSeries({ ...opts, title: `BB Upper` });
        const sm = main.addLineSeries({ ...opts, lineStyle: LineStyle.Dashed, title: `BB Mid` });
        const sl = main.addLineSeries({ ...opts, title: `BB Lower` });
        su.setData(toChartData(times, upper) as { time: Time; value: number }[]);
        sm.setData(toChartData(times, middle) as { time: Time; value: number }[]);
        sl.setData(toChartData(times, lower) as { time: Time; value: number }[]);
        overlaySeriesRef.current.push(su, sm, sl);
      }
    }

    // --- Oscillator sub-chart (based on activeOsc) ---
    renderOscillator(sub, times, closes, highs, lows, currentSIR, activeOsc);

  }, [candles, currentSIR, activeOsc]); // eslint-disable-line react-hooks/exhaustive-deps

  function renderOscillator(
    sub: IChartApi,
    times: number[],
    closes: number[],
    highs: number[],
    lows: number[],
    sir: StrategyIR,
    osc: OscTab,
  ) {
    subSeriesRef.current.forEach((s) => sub.removeSeries(s));
    subSeriesRef.current = [];

    const conds = sir.entry_conditions.filter((c) => c.indicator.toUpperCase() === osc);

    if (osc === "RSI") {
      const period = conds[0]?.period ?? 14;
      const data = toChartData(times, rsi(closes, period));
      const s = sub.addLineSeries({ color: OSC_COLORS.rsi, lineWidth: 1 as LineWidth, priceLineVisible: false, title: `RSI ${period}` });
      s.setData(data as { time: Time; value: number }[]);
      // Reference lines at 30/70
      s.createPriceLine({ price: 70, color: "#ef4444", lineWidth: 1 as LineWidth, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: "70" });
      s.createPriceLine({ price: 30, color: "#22c55e", lineWidth: 1 as LineWidth, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: "30" });
      subSeriesRef.current.push(s);

    } else if (osc === "MACD") {
      const cond = conds[0];
      const fast = cond?.fast ?? 12, slow = cond?.slow ?? 26, sig = cond?.signal_period ?? 9;
      const { line, signal, hist } = macd(closes, fast, slow, sig);
      const sLine = sub.addLineSeries({ color: OSC_COLORS.macdLine, lineWidth: 1 as LineWidth, priceLineVisible: false, title: `MACD` });
      const sSig = sub.addLineSeries({ color: OSC_COLORS.macdSig, lineWidth: 1 as LineWidth, priceLineVisible: false, title: `Signal` });
      const sHist = sub.addHistogramSeries({ priceLineVisible: false, title: `Hist` });
      sLine.setData(toChartData(times, line) as { time: Time; value: number }[]);
      sSig.setData(toChartData(times, signal) as { time: Time; value: number }[]);
      sHist.setData(
        times.flatMap((t, i) => {
          if (hist[i] === null) return [];
          const v = hist[i] as number;
          return [{ time: t as Time, value: v, color: v >= 0 ? "#22c55e99" : "#ef444499" }];
        }),
      );
      subSeriesRef.current.push(sLine, sSig, sHist);

    } else if (osc === "ADX") {
      const period = conds[0]?.period ?? 14;
      const data = toChartData(times, adx(highs, lows, closes, period));
      const s = sub.addLineSeries({ color: OSC_COLORS.adx, lineWidth: 1 as LineWidth, priceLineVisible: false, title: `ADX ${period}` });
      s.setData(data as { time: Time; value: number }[]);
      s.createPriceLine({ price: 25, color: "#6b7280", lineWidth: 1 as LineWidth, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: "25" });
      subSeriesRef.current.push(s);

    } else if (osc === "STOCH") {
      const cond = conds[0];
      const kP = cond?.period ?? 14, kS = cond?.k_smooth ?? 3, dP = cond?.d_period ?? 3;
      const { k, d } = stochastic(highs, lows, closes, kP, kS, dP);
      const sK = sub.addLineSeries({ color: OSC_COLORS.stochK, lineWidth: 1 as LineWidth, priceLineVisible: false, title: `%K` });
      const sD = sub.addLineSeries({ color: OSC_COLORS.stochD, lineWidth: 1 as LineWidth, lineStyle: LineStyle.Dashed, priceLineVisible: false, title: `%D` });
      sK.setData(toChartData(times, k) as { time: Time; value: number }[]);
      sD.setData(toChartData(times, d) as { time: Time; value: number }[]);
      sK.createPriceLine({ price: 80, color: "#ef4444", lineWidth: 1 as LineWidth, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: "80" });
      sK.createPriceLine({ price: 20, color: "#22c55e", lineWidth: 1 as LineWidth, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: "20" });
      subSeriesRef.current.push(sK, sD);

    } else if (osc === "ATR") {
      const period = conds[0]?.period ?? 14;
      const data = toChartData(times, atr(highs, lows, closes, period));
      const s = sub.addLineSeries({ color: OSC_COLORS.atr, lineWidth: 1 as LineWidth, priceLineVisible: false, title: `ATR ${period}` });
      s.setData(data as { time: Time; value: number }[]);
      subSeriesRef.current.push(s);
    }

    sub.timeScale().fitContent();
  }

  // ---------------------------------------------------------------------------
  // Trade markers
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (!candleSeriesRef.current) return;
    if (trades.length === 0) {
      candleSeriesRef.current.setMarkers([]);
      return;
    }
    const markers = trades.flatMap((t) => {
      const entryTs = Math.floor(new Date(t.entry_time).getTime() / 1000);
      const exitTs = Math.floor(new Date(t.exit_time).getTime() / 1000);
      const win = t.pnl >= 0;
      return [
        {
          time: entryTs as Time,
          position: t.direction === "long" ? "belowBar" as const : "aboveBar" as const,
          color: "#3b82f6",
          shape: t.direction === "long" ? "arrowUp" as const : "arrowDown" as const,
          text: "IN",
        },
        {
          time: exitTs as Time,
          position: t.direction === "long" ? "aboveBar" as const : "belowBar" as const,
          color: win ? CHART_THEME.upColor : CHART_THEME.downColor,
          shape: "circle" as const,
          text: `${win ? "+" : ""}${t.pnl.toFixed(0)}`,
        },
      ];
    });
    // Sort markers by time (required by lightweight-charts)
    markers.sort((a, b) => (a.time as number) - (b.time as number));
    candleSeriesRef.current.setMarkers(markers);
  }, [trades]);

  // ---------------------------------------------------------------------------
  // Derived state
  // ---------------------------------------------------------------------------
  const isModified = currentSIR && originalSIR
    ? JSON.stringify(currentSIR.entry_conditions) !== JSON.stringify(originalSIR.entry_conditions)
    : false;

  const selectedStratName = strategies.find((s) => s.id === selectedStratId)?.description ?? "";

  const oscillatorsInStrategy: OscTab[] = currentSIR
    ? (["RSI", "MACD", "ADX", "STOCH", "ATR"] as OscTab[]).filter((o) =>
        currentSIR.entry_conditions.some((c) => c.indicator.toUpperCase() === o),
      )
    : [];

  // ---------------------------------------------------------------------------
  // Indicator editing
  // ---------------------------------------------------------------------------
  function updateCondition(idx: number, patch: Partial<IndicatorCondition>) {
    if (!currentSIR) return;
    const conds = currentSIR.entry_conditions.map((c, i) =>
      i === idx ? { ...c, ...patch } : c,
    );
    setCurrentSIR({ ...currentSIR, entry_conditions: conds });
  }

  // ---------------------------------------------------------------------------
  // Save draft → navigate
  // ---------------------------------------------------------------------------
  async function handleAction(action: "backtest" | "optimize" | "refine") {
    let stratId = selectedStratId;
    setDraftError("");

    if (isModified && currentSIR) {
      setSavingDraft(true);
      try {
        const res = await fetchWithAuth(`${API_BASE}/api/strategies`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ir_json: currentSIR,
            description: `[Draft] ${selectedStratName}`,
            pair,
            timeframe,
          }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const saved = await res.json();
        stratId = saved.id;
        setSelectedStratId(saved.id);
        setOriginalSIR(JSON.parse(JSON.stringify(currentSIR)));
        // Reload strategies list
        const sRes = await fetchWithAuth(`${API_BASE}/api/strategies`);
        setStrategies(await sRes.json());
      } catch (e) {
        setDraftError(e instanceof Error ? e.message : "Save failed");
        setSavingDraft(false);
        return;
      }
      setSavingDraft(false);
    }

    switch (action) {
      case "backtest":
        router.push(`/backtest?strategy_id=${stratId}`);
        break;
      case "optimize":
        router.push(`/optimization?strategy_id=${stratId}`);
        break;
      case "refine":
        router.push(`/copilot?strategy_id=${stratId}&refine=1`);
        break;
    }
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------
  const showSubChart = oscillatorsInStrategy.length > 0 || true; // always show sub chart

  return (
    <div className="flex flex-col h-screen bg-[#09090b] text-zinc-200 overflow-hidden">
      {/* ------------------------------------------------------------------ */}
      {/* Toolbar                                                             */}
      {/* ------------------------------------------------------------------ */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-zinc-800 flex-shrink-0 flex-wrap">
        <select
          value={pair}
          onChange={(e) => setPair(e.target.value)}
          className="bg-zinc-800 text-zinc-200 text-xs rounded px-2 py-1 border border-zinc-700"
        >
          {PAIRS.map((p) => <option key={p}>{p}</option>)}
        </select>
        <select
          value={timeframe}
          onChange={(e) => setTimeframe(e.target.value)}
          className="bg-zinc-800 text-zinc-200 text-xs rounded px-2 py-1 border border-zinc-700"
        >
          {TIMEFRAMES.map((t) => <option key={t}>{t}</option>)}
        </select>
        <input
          type="date"
          value={dateFrom}
          onChange={(e) => setDateFrom(e.target.value)}
          className="bg-zinc-800 text-zinc-200 text-xs rounded px-2 py-1 border border-zinc-700"
        />
        <span className="text-zinc-600 text-xs">→</span>
        <input
          type="date"
          value={dateTo}
          onChange={(e) => setDateTo(e.target.value)}
          className="bg-zinc-800 text-zinc-200 text-xs rounded px-2 py-1 border border-zinc-700"
        />
        {loadingCandles && (
          <span className="text-xs text-zinc-500 ml-2 animate-pulse">Loading…</span>
        )}
        {candles.length > 0 && !loadingCandles && (
          <span className="text-xs text-zinc-600">{candles.length.toLocaleString()} bars</span>
        )}
        {isModified && (
          <span className="flex items-center gap-1 text-xs text-amber-400 font-medium">
            <span className="h-1.5 w-1.5 rounded-full bg-amber-400 inline-block" />
            Modified
          </span>
        )}

        {/* Action buttons */}
        <div className="ml-auto flex items-center gap-1">
          <button
            onClick={() => handleAction("backtest")}
            disabled={!selectedStratId || savingDraft}
            className="rounded border border-blue-700 px-1.5 py-0.5 text-[10px] text-blue-400 hover:bg-blue-900/30 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          >
            Backtest
          </button>
          <button
            onClick={() => handleAction("optimize")}
            disabled={!selectedStratId || savingDraft}
            className="rounded border border-blue-700 px-1.5 py-0.5 text-[10px] text-blue-400 hover:bg-blue-900/30 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          >
            Optimize
          </button>
          <button
            onClick={() => handleAction("refine")}
            disabled={!selectedStratId || savingDraft}
            className="rounded border border-blue-700 px-1.5 py-0.5 text-[10px] text-blue-400 hover:bg-blue-900/30 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          >
            Refine
          </button>
        </div>
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* Main area                                                           */}
      {/* ------------------------------------------------------------------ */}
      <div className="flex flex-1 overflow-hidden">
        {/* Chart column */}
        <div className="flex flex-col flex-1 overflow-hidden">
          {/* Main candlestick chart */}
          <div
            ref={mainDivRef}
            className="flex-1"
            style={{ minHeight: 0 }}
          />

          {/* Oscillator tab bar */}
          <div className="flex items-center gap-1 px-2 py-1 border-t border-b border-zinc-800 bg-zinc-900 flex-shrink-0">
            <span className="text-[10px] text-zinc-600 mr-1">OSC</span>
            {(["RSI", "MACD", "ADX", "STOCH", "ATR"] as OscTab[]).map((tab) => {
              const inStrategy = oscillatorsInStrategy.includes(tab);
              return (
                <button
                  key={tab}
                  onClick={() => setActiveOsc(tab)}
                  className={[
                    "text-[10px] px-2 py-0.5 rounded transition-colors",
                    activeOsc === tab
                      ? "bg-blue-600 text-white"
                      : inStrategy
                        ? "bg-zinc-700 text-zinc-200 hover:bg-zinc-600"
                        : "bg-zinc-800 text-zinc-500 hover:bg-zinc-700",
                  ].join(" ")}
                >
                  {tab}
                </button>
              );
            })}
          </div>

          {/* Sub oscillator chart */}
          <div
            ref={subDivRef}
            className="flex-shrink-0"
            style={{ height: 160 }}
          />
        </div>

        {/* ---------------------------------------------------------------- */}
        {/* Right control panel                                              */}
        {/* ---------------------------------------------------------------- */}
        <div className="w-72 flex-shrink-0 border-l border-zinc-800 flex flex-col overflow-y-auto">

          {/* Strategy selector */}
          <Section title="Strategy">
            <select
              value={selectedStratId}
              onChange={(e) => setSelectedStratId(e.target.value)}
              className="w-full bg-zinc-800 text-zinc-200 text-xs rounded px-2 py-1.5 border border-zinc-700"
            >
              {strategies.length === 0 && <option value="">No strategies</option>}
              {strategies.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.description} ({s.pair} {s.timeframe})
                </option>
              ))}
            </select>
          </Section>

          {/* Backtest overlay */}
          <Section title="Backtest Overlay">
            <select
              value={selectedBtId}
              onChange={(e) => setSelectedBtId(e.target.value)}
              className="w-full bg-zinc-800 text-zinc-200 text-xs rounded px-2 py-1.5 border border-zinc-700"
            >
              <option value="">None — no trade markers</option>
              {backtests.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.period_start.slice(0, 10)} → {b.period_end.slice(0, 10)}
                  {b.sharpe != null ? ` · S ${b.sharpe.toFixed(2)}` : ""}
                  {b.trade_count != null ? ` · ${b.trade_count}T` : ""}
                </option>
              ))}
            </select>
            {selectedBtId && trades.length > 0 && (
              <p className="text-[10px] text-zinc-500 mt-1">
                {trades.length} trades overlaid on chart
              </p>
            )}
          </Section>

          {/* Indicator editor */}
          <Section title="Entry Conditions">
            {!currentSIR || currentSIR.entry_conditions.length === 0 ? (
              <p className="text-xs text-zinc-500">Select a strategy to edit indicators.</p>
            ) : (
              <div className="space-y-3">
                {currentSIR.entry_conditions.map((cond, idx) => (
                  <ConditionEditor
                    key={idx}
                    index={idx}
                    cond={cond}
                    onChange={(patch) => updateCondition(idx, patch)}
                  />
                ))}
              </div>
            )}
          </Section>

          {/* Exit conditions (read-only summary) */}
          {currentSIR?.exit_conditions && (
            <Section title="Exit Conditions">
              <div className="space-y-1 text-[11px] text-zinc-400">
                {currentSIR.exit_conditions.stop_loss && (
                  <div>SL: ATR × {currentSIR.exit_conditions.stop_loss.multiplier ?? "?"} (p={currentSIR.exit_conditions.stop_loss.period ?? "?"})</div>
                )}
                {currentSIR.exit_conditions.take_profit && (
                  <div>TP: ATR × {currentSIR.exit_conditions.take_profit.multiplier ?? "?"} (p={currentSIR.exit_conditions.take_profit.period ?? "?"})</div>
                )}
              </div>
            </Section>
          )}

          {/* Spacer */}
          <div className="flex-1" />

          {draftError && (
            <p className="px-3 pb-2 text-xs text-red-400">{draftError}</p>
          )}
          {savingDraft && (
            <p className="px-3 pb-2 text-[10px] text-zinc-500 text-center animate-pulse">Saving draft…</p>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="border-b border-zinc-800 px-3 py-3">
      <h3 className="text-[10px] font-semibold uppercase tracking-widest text-zinc-500 mb-2">
        {title}
      </h3>
      {children}
    </div>
  );
}

function ActionButton({
  label,
  onClick,
  disabled,
  color,
}: {
  label: string;
  onClick: () => void;
  disabled: boolean;
  color: "blue" | "purple" | "zinc";
}) {
  const base = "w-full text-xs rounded px-3 py-2 font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed";
  const colors = {
    blue: "bg-blue-600 hover:bg-blue-500 text-white",
    purple: "bg-purple-700 hover:bg-purple-600 text-white",
    zinc: "bg-zinc-700 hover:bg-zinc-600 text-zinc-200",
  };
  return (
    <button className={`${base} ${colors[color]}`} onClick={onClick} disabled={disabled}>
      {label}
    </button>
  );
}

function ConditionEditor({
  index,
  cond,
  onChange,
}: {
  index: number;
  cond: IndicatorCondition;
  onChange: (patch: Partial<IndicatorCondition>) => void;
}) {
  const ind = cond.indicator.toUpperCase();
  const isThreshold = [">", "<", ">=", "<=", "==", "crossed_above", "crossed_below"].includes(cond.operator);

  return (
    <div className="bg-zinc-800/60 rounded p-2 space-y-1.5 text-[11px]">
      <div className="flex items-center justify-between">
        <span className="font-mono font-semibold text-blue-400">{ind}</span>
        <span className="text-zinc-500">#{index}</span>
      </div>

      {/* Period */}
      <Label label="Period">
        <NumberInput
          value={cond.period}
          min={2}
          max={500}
          onChange={(v) => onChange({ period: v })}
        />
      </Label>

      {/* MACD fast/slow/signal */}
      {ind === "MACD" && (
        <>
          <Label label="Fast">
            <NumberInput value={cond.fast ?? 12} min={2} max={200} onChange={(v) => onChange({ fast: v })} />
          </Label>
          <Label label="Slow">
            <NumberInput value={cond.slow ?? 26} min={2} max={500} onChange={(v) => onChange({ slow: v })} />
          </Label>
          <Label label="Signal">
            <NumberInput value={cond.signal_period ?? 9} min={2} max={100} onChange={(v) => onChange({ signal_period: v })} />
          </Label>
        </>
      )}

      {/* BB std_dev */}
      {ind === "BB" && (
        <Label label="Std Dev">
          <input
            type="number"
            value={cond.std_dev ?? 2.0}
            step={0.1}
            min={0.5}
            max={5}
            onChange={(e) => onChange({ std_dev: parseFloat(e.target.value) })}
            className="w-20 bg-zinc-700 rounded px-1.5 py-0.5 text-zinc-200 text-right"
          />
        </Label>
      )}

      {/* Stochastic k_smooth / d_period */}
      {ind === "STOCH" && (
        <>
          <Label label="K Smooth">
            <NumberInput value={cond.k_smooth ?? 3} min={1} max={50} onChange={(v) => onChange({ k_smooth: v })} />
          </Label>
          <Label label="D Period">
            <NumberInput value={cond.d_period ?? 3} min={1} max={50} onChange={(v) => onChange({ d_period: v })} />
          </Label>
        </>
      )}

      {/* Operator */}
      <Label label="Operator">
        <select
          value={cond.operator}
          onChange={(e) => onChange({ operator: e.target.value })}
          className="bg-zinc-700 rounded px-1.5 py-0.5 text-zinc-200"
        >
          {[">", "<", ">=", "<=", "==", "crossed_above", "crossed_below", "price_above", "price_below"].map((op) => (
            <option key={op}>{op}</option>
          ))}
        </select>
      </Label>

      {/* Threshold value */}
      {isThreshold && (
        <Label label="Value">
          <input
            type="number"
            value={cond.value ?? ""}
            step="any"
            onChange={(e) => onChange({ value: e.target.value === "" ? null : parseFloat(e.target.value) })}
            className="w-20 bg-zinc-700 rounded px-1.5 py-0.5 text-zinc-200 text-right"
          />
        </Label>
      )}
    </div>
  );
}

function Label({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-zinc-500 flex-shrink-0">{label}</span>
      {children}
    </div>
  );
}

function NumberInput({
  value,
  min,
  max,
  onChange,
}: {
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
}) {
  return (
    <input
      type="number"
      value={value}
      min={min}
      max={max}
      onChange={(e) => {
        const v = parseInt(e.target.value, 10);
        if (!isNaN(v) && v >= min && v <= max) onChange(v);
      }}
      className="w-20 bg-zinc-700 rounded px-1.5 py-0.5 text-zinc-200 text-right"
    />
  );
}
