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
import DiagnosisPanel from "@/components/DiagnosisPanel";
import Spinbox from "@/components/Spinbox";
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
const SC_STORAGE_KEY = "superchart_state";

// ---------------------------------------------------------------------------
// localStorage persistence helpers
// ---------------------------------------------------------------------------
interface PersistedSCState {
  pair: string;
  timeframe: string;
  dateFrom: string;
  dateTo: string;
  activeOsc: OscTab;
  oscParams: OscParams;
  chartOverlays: ChartOverlay[];
  selectedStratId: string;
  selectedBtId: string;
}

function scLoad(): Partial<PersistedSCState> {
  try { return JSON.parse(localStorage.getItem(SC_STORAGE_KEY) ?? "{}"); } catch { return {}; }
}
function scSave(patch: Partial<PersistedSCState>) {
  try { localStorage.setItem(SC_STORAGE_KEY, JSON.stringify({ ...scLoad(), ...patch })); } catch {}
}
function scClear() {
  try { localStorage.removeItem(SC_STORAGE_KEY); } catch {}
}
const PAIRS = ["EURUSD", "GBPUSD", "USDJPY", "EURGBP", "GBPJPY", "USDCHF"];
const TIMEFRAMES = ["1m", "5m", "15m", "30m", "1H", "4H", "1D"];

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
type IndicatorType = "EMA" | "SMA" | "BB" | "RSI" | "MACD" | "ADX" | "STOCH" | "ATR";

interface OscParams {
  RSI:   { period: number };
  MACD:  { fast: number; slow: number; signal_period: number };
  ADX:   { period: number };
  STOCH: { period: number; k_smooth: number; d_period: number };
  ATR:   { period: number };
}

const DEFAULT_OSC_PARAMS: OscParams = {
  RSI:   { period: 14 },
  MACD:  { fast: 12, slow: 26, signal_period: 9 },
  ADX:   { period: 14 },
  STOCH: { period: 14, k_smooth: 3, d_period: 3 },
  ATR:   { period: 14 },
};

interface ChartOverlay {
  id: string;
  type: IndicatorType;
  period: number;
  fast: number;
  slow: number;
  signal_period: number;
  std_dev: number;
  k_smooth: number;
  d_period: number;
  color: string;
}

const USER_OVERLAY_COLORS = ["#ec4899", "#10b981", "#84cc16", "#38bdf8", "#c084fc", "#fb923c", "#facc15"];
const MAIN_INDICATORS: IndicatorType[] = ["EMA", "SMA", "BB"];
const ALL_INDICATORS: IndicatorType[] = ["EMA", "SMA", "BB", "RSI", "MACD", "ADX", "STOCH", "ATR"];

const INDICATOR_DEFAULTS: Record<IndicatorType, Partial<ChartOverlay>> = {
  EMA:   { period: 20 },
  SMA:   { period: 50 },
  BB:    { period: 20, std_dev: 2.0 },
  RSI:   { period: 14 },
  MACD:  { fast: 12, slow: 26, signal_period: 9, period: 12 },
  ADX:   { period: 14 },
  STOCH: { period: 14, k_smooth: 3, d_period: 3 },
  ATR:   { period: 14 },
};

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
  const [pair, setPair] = useState<string>(() => scLoad().pair ?? "EURUSD");
  const [timeframe, setTimeframe] = useState<string>(() => scLoad().timeframe ?? "1H");
  const [dateFrom, setDateFrom] = useState<string>(() => scLoad().dateFrom ?? defaultDateFrom());
  const [dateTo, setDateTo] = useState<string>(() => scLoad().dateTo ?? defaultDateTo());

  // --- loaded data ---
  const [candles, setCandles] = useState<Candle[]>([]);
  const [strategies, setStrategies] = useState<Strategy[]>([]);
  const [selectedStratId, setSelectedStratId] = useState<string>(() => scLoad().selectedStratId ?? "");
  const [backtests, setBacktests] = useState<BacktestResult[]>([]);
  const [selectedBtId, setSelectedBtId] = useState<string>(() => scLoad().selectedBtId ?? "");
  const [trades, setTrades] = useState<Trade[]>([]);

  // --- strategy IR (editable copy) ---
  const [currentSIR, setCurrentSIR] = useState<StrategyIR | null>(null);
  const [originalSIR, setOriginalSIR] = useState<StrategyIR | null>(null);

  // --- chart indicator overlays ---
  const [chartOverlays, setChartOverlays] = useState<ChartOverlay[]>(() => scLoad().chartOverlays ?? []);
  const [newOverlayType, setNewOverlayType] = useState<IndicatorType>("EMA");
  const userOverlaySeriesRef = useRef<ISeriesApi<"Line">[]>([]);
  const userSubSeriesRef = useRef<ISeriesApi<"Line" | "Histogram">[]>([]);

  // --- Lab Indicators overlay ---
  const [savedLabIndicators, setSavedLabIndicators] = useState<{id:string;name:string;status:string;indicator_config:{indicators:{type:string;params:Record<string,unknown>;color?:string}[]}}[]>([]);
  const [loadedLabIndicators, setLoadedLabIndicators] = useState<{id:string;name:string;data:{pane:string;series:{name:string;color:string;data:{time:number;value:number}[]}[]}[]}[]>([]);
  const labSeriesRef = useRef<ISeriesApi<"Line">[]>([]);

  // --- period diagnosis ---
  const [diagPeriodStart, setDiagPeriodStart] = useState("");
  const [diagPeriodEnd, setDiagPeriodEnd] = useState("");
  const [diagPanelOpen, setDiagPanelOpen] = useState(false);

  // --- UI state ---
  const [loadingCandles, setLoadingCandles] = useState(false);
  const [activeOsc, setActiveOsc] = useState<OscTab>(() => scLoad().activeOsc ?? "RSI");
  const [oscParams, setOscParams] = useState<OscParams>(() => ({ ...DEFAULT_OSC_PARAMS, ...scLoad().oscParams }));
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

    // Synchronise scroll/zoom between the two charts by time (not bar index)
    main.timeScale().subscribeVisibleTimeRangeChange((range) => {
      if (syncingRef.current || !range) return;
      syncingRef.current = true;
      try { sub.timeScale().setVisibleRange(range); } catch { /* sub chart may have no data yet */ }
      syncingRef.current = false;
    });
    sub.timeScale().subscribeVisibleTimeRangeChange((range) => {
      if (syncingRef.current || !range) return;
      syncingRef.current = true;
      try { main.timeScale().setVisibleRange(range); } catch { /* main chart may have no data yet */ }
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
        const savedStratId = scLoad().selectedStratId;
        const initial = (urlStratId && data.find((s) => s.id === urlStratId))
          ? urlStratId
          : (savedStratId && data.find((s) => s.id === savedStratId))
          ? savedStratId
          : data.length > 0 ? data[0].id : "";
        setSelectedStratId(initial);
      })
      .catch(() => {});
  }, []);

  // ---------------------------------------------------------------------------
  // Load saved Lab indicators list + handle indicator_id URL param
  // ---------------------------------------------------------------------------
  useEffect(() => {
    fetchWithAuth(`${API_BASE}/api/lab/indicators/saved`)
      .then((r) => r.ok ? r.json() : [])
      .then((data) => {
        setSavedLabIndicators(data);
        const urlIndId = searchParams.get("indicator_id");
        if (urlIndId) {
          const ind = data.find((i: {id:string}) => i.id === urlIndId);
          if (ind) loadLabIndicator(ind);
        }
      })
      .catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------------------------------------------------------------------------
  // Render loaded Lab indicator series (dotted overlays on main chart)
  // ---------------------------------------------------------------------------
  useEffect(() => {
    const main = mainChartRef.current;
    if (!main) return;
    labSeriesRef.current.forEach(s => { try { main.removeSeries(s); } catch {} });
    labSeriesRef.current = [];
    for (const loaded of loadedLabIndicators) {
      for (const group of loaded.data) {
        if (group.pane !== "overlay") continue;
        for (const series of group.series) {
          const s = main.addLineSeries({
            color: series.color, lineWidth: 1,
            lineStyle: 3, // Dotted
            priceLineVisible: false, lastValueVisible: false,
            title: `[${loaded.name}] ${series.name}`,
          });
          s.setData(series.data as { time: Time; value: number }[]);
          labSeriesRef.current.push(s);
        }
      }
    }
  }, [loadedLabIndicators]); // eslint-disable-line react-hooks/exhaustive-deps

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
        const savedBtId = scLoad().selectedBtId;
        const initial = (urlBtId && data.find((b) => b.id === urlBtId))
          ? urlBtId
          : (savedBtId && data.find((b) => b.id === savedBtId))
          ? savedBtId
          : "";
        setSelectedBtId(initial);
        setTrades([]);
      })
      .catch(() => {});
  }, [selectedStratId, strategies]);

  // Sync oscParams from SIR entry conditions when strategy changes
  useEffect(() => {
    if (!currentSIR) return;
    const conds = currentSIR.entry_conditions;
    setOscParams((prev) => {
      const next = { ...prev };
      for (const c of conds) {
        const ind = c.indicator.toUpperCase() as OscTab;
        if (ind === "RSI" && c.period)   next.RSI   = { period: c.period };
        if (ind === "ADX" && c.period)   next.ADX   = { period: c.period };
        if (ind === "ATR" && c.period)   next.ATR   = { period: c.period };
        if (ind === "MACD")              next.MACD  = { fast: c.fast ?? 12, slow: c.slow ?? 26, signal_period: c.signal_period ?? 9 };
        if (ind === "STOCH")             next.STOCH = { period: c.period ?? 14, k_smooth: c.k_smooth ?? 3, d_period: c.d_period ?? 3 };
      }
      return next;
    });
  }, [currentSIR]);

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
      // Pre-fill diagnosis period with the full backtest window
      setDiagPeriodStart(bt.period_start.slice(0, 10));
      setDiagPeriodEnd(bt.period_end.slice(0, 10));
      setDiagPanelOpen(false);
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
    renderOscillator(sub, times, closes, highs, lows, activeOsc, oscParams);

  }, [candles, currentSIR, activeOsc, oscParams]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------------------------------------------------------------------------
  // Render user-added indicator overlays
  // ---------------------------------------------------------------------------
  useEffect(() => {
    const main = mainChartRef.current;
    const sub  = subChartRef.current;
    if (!main || !sub || candles.length === 0) return;

    userOverlaySeriesRef.current.forEach((s) => { try { main.removeSeries(s); } catch {} });
    userOverlaySeriesRef.current = [];
    userSubSeriesRef.current.forEach((s) => { try { sub.removeSeries(s); } catch {} });
    userSubSeriesRef.current = [];

    const times  = candles.map((c) => c.time);
    const closes = candles.map((c) => c.close);
    const highs  = candles.map((c) => c.high);
    const lows   = candles.map((c) => c.low);

    for (const ov of chartOverlays) {
      const { type, color, period } = ov;

      if (type === "EMA") {
        const s = main.addLineSeries({ color, lineWidth: 1 as LineWidth, priceLineVisible: false, lastValueVisible: false, title: `EMA ${period}` });
        s.setData(toChartData(times, ema(closes, period)) as { time: Time; value: number }[]);
        userOverlaySeriesRef.current.push(s);

      } else if (type === "SMA") {
        const s = main.addLineSeries({ color, lineWidth: 1 as LineWidth, lineStyle: LineStyle.Dashed, priceLineVisible: false, lastValueVisible: false, title: `SMA ${period}` });
        s.setData(toChartData(times, sma(closes, period)) as { time: Time; value: number }[]);
        userOverlaySeriesRef.current.push(s);

      } else if (type === "BB") {
        const { upper, middle, lower } = bollingerBands(closes, period, ov.std_dev);
        const opts = { color, lineWidth: 1 as LineWidth, priceLineVisible: false, lastValueVisible: false };
        const su = main.addLineSeries({ ...opts, title: `BB ${period} U` });
        const sm2 = main.addLineSeries({ ...opts, lineStyle: LineStyle.Dashed, title: `BB ${period} M` });
        const sl = main.addLineSeries({ ...opts, title: `BB ${period} L` });
        su.setData(toChartData(times, upper)  as { time: Time; value: number }[]);
        sm2.setData(toChartData(times, middle) as { time: Time; value: number }[]);
        sl.setData(toChartData(times, lower)  as { time: Time; value: number }[]);
        userOverlaySeriesRef.current.push(su, sm2, sl);

      } else if (type === "RSI") {
        const s = sub.addLineSeries({ color, lineWidth: 1 as LineWidth, priceLineVisible: false, title: `RSI ${period}` });
        s.setData(toChartData(times, rsi(closes, period)) as { time: Time; value: number }[]);
        s.createPriceLine({ price: 70, color: "#ef4444", lineWidth: 1 as LineWidth, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: "70" });
        s.createPriceLine({ price: 30, color: "#22c55e", lineWidth: 1 as LineWidth, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: "30" });
        userSubSeriesRef.current.push(s);

      } else if (type === "MACD") {
        const { line, signal, hist } = macd(closes, ov.fast, ov.slow, ov.signal_period);
        const sLine = sub.addLineSeries({ color, lineWidth: 1 as LineWidth, priceLineVisible: false, title: `MACD` });
        const sSig  = sub.addLineSeries({ color: "#f97316", lineWidth: 1 as LineWidth, priceLineVisible: false, title: `Signal` });
        const sHist = sub.addHistogramSeries({ priceLineVisible: false, title: `Hist` });
        sLine.setData(toChartData(times, line)   as { time: Time; value: number }[]);
        sSig.setData(toChartData(times, signal)  as { time: Time; value: number }[]);
        sHist.setData(times.flatMap((t, i) => {
          if (hist[i] === null) return [];
          const v = hist[i] as number;
          return [{ time: t as Time, value: v, color: v >= 0 ? "#22c55e99" : "#ef444499" }];
        }));
        userSubSeriesRef.current.push(sLine, sSig, sHist);

      } else if (type === "ADX") {
        const s = sub.addLineSeries({ color, lineWidth: 1 as LineWidth, priceLineVisible: false, title: `ADX ${period}` });
        s.setData(toChartData(times, adx(highs, lows, closes, period)) as { time: Time; value: number }[]);
        s.createPriceLine({ price: 25, color: "#6b7280", lineWidth: 1 as LineWidth, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: "25" });
        userSubSeriesRef.current.push(s);

      } else if (type === "STOCH") {
        const { k, d } = stochastic(highs, lows, closes, period, ov.k_smooth, ov.d_period);
        const sK = sub.addLineSeries({ color, lineWidth: 1 as LineWidth, priceLineVisible: false, title: `%K` });
        const sD = sub.addLineSeries({ color: "#f97316", lineWidth: 1 as LineWidth, lineStyle: LineStyle.Dashed, priceLineVisible: false, title: `%D` });
        sK.setData(toChartData(times, k) as { time: Time; value: number }[]);
        sD.setData(toChartData(times, d) as { time: Time; value: number }[]);
        sK.createPriceLine({ price: 80, color: "#ef4444", lineWidth: 1 as LineWidth, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: "80" });
        sK.createPriceLine({ price: 20, color: "#22c55e", lineWidth: 1 as LineWidth, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: "20" });
        userSubSeriesRef.current.push(sK, sD);

      } else if (type === "ATR") {
        const s = sub.addLineSeries({ color, lineWidth: 1 as LineWidth, priceLineVisible: false, title: `ATR ${period}` });
        s.setData(toChartData(times, atr(highs, lows, closes, period)) as { time: Time; value: number }[]);
        userSubSeriesRef.current.push(s);
      }
    }
  }, [candles, chartOverlays]); // eslint-disable-line react-hooks/exhaustive-deps

  function addOverlay() {
    const defaults = INDICATOR_DEFAULTS[newOverlayType];
    const color = USER_OVERLAY_COLORS[chartOverlays.length % USER_OVERLAY_COLORS.length];
    setChartOverlays((prev) => [...prev, {
      id: Math.random().toString(36).slice(2),
      type: newOverlayType,
      period: 14, fast: 12, slow: 26, signal_period: 9,
      std_dev: 2.0, k_smooth: 3, d_period: 3,
      color,
      ...defaults,
    }]);
  }

  function updateOverlay(id: string, patch: Partial<ChartOverlay>) {
    setChartOverlays((prev) => prev.map((o) => o.id === id ? { ...o, ...patch } : o));
  }

  function removeOverlay(id: string) {
    setChartOverlays((prev) => prev.filter((o) => o.id !== id));
  }

  function renderOscillator(
    sub: IChartApi,
    times: number[],
    closes: number[],
    highs: number[],
    lows: number[],
    osc: OscTab,
    params: OscParams,
  ) {
    subSeriesRef.current.forEach((s) => sub.removeSeries(s));
    subSeriesRef.current = [];

    if (osc === "RSI") {
      const { period } = params.RSI;
      const data = toChartData(times, rsi(closes, period));
      const s = sub.addLineSeries({ color: OSC_COLORS.rsi, lineWidth: 1 as LineWidth, priceLineVisible: false, title: `RSI ${period}` });
      s.setData(data as { time: Time; value: number }[]);
      // Reference lines at 30/70
      s.createPriceLine({ price: 70, color: "#ef4444", lineWidth: 1 as LineWidth, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: "70" });
      s.createPriceLine({ price: 30, color: "#22c55e", lineWidth: 1 as LineWidth, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: "30" });
      subSeriesRef.current.push(s);

    } else if (osc === "MACD") {
      const { fast, slow, signal_period: sig } = params.MACD;
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
      const { period } = params.ADX;
      const data = toChartData(times, adx(highs, lows, closes, period));
      const s = sub.addLineSeries({ color: OSC_COLORS.adx, lineWidth: 1 as LineWidth, priceLineVisible: false, title: `ADX ${period}` });
      s.setData(data as { time: Time; value: number }[]);
      s.createPriceLine({ price: 25, color: "#6b7280", lineWidth: 1 as LineWidth, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: "25" });
      subSeriesRef.current.push(s);

    } else if (osc === "STOCH") {
      const { period: kP, k_smooth: kS, d_period: dP } = params.STOCH;
      const { k, d } = stochastic(highs, lows, closes, kP, kS, dP);
      const sK = sub.addLineSeries({ color: OSC_COLORS.stochK, lineWidth: 1 as LineWidth, priceLineVisible: false, title: `%K` });
      const sD = sub.addLineSeries({ color: OSC_COLORS.stochD, lineWidth: 1 as LineWidth, lineStyle: LineStyle.Dashed, priceLineVisible: false, title: `%D` });
      sK.setData(toChartData(times, k) as { time: Time; value: number }[]);
      sD.setData(toChartData(times, d) as { time: Time; value: number }[]);
      sK.createPriceLine({ price: 80, color: "#ef4444", lineWidth: 1 as LineWidth, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: "80" });
      sK.createPriceLine({ price: 20, color: "#22c55e", lineWidth: 1 as LineWidth, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: "20" });
      subSeriesRef.current.push(sK, sD);

    } else if (osc === "ATR") {
      const { period } = params.ATR;
      const data = toChartData(times, atr(highs, lows, closes, period));
      const s = sub.addLineSeries({ color: OSC_COLORS.atr, lineWidth: 1 as LineWidth, priceLineVisible: false, title: `ATR ${period}` });
      s.setData(data as { time: Time; value: number }[]);
      subSeriesRef.current.push(s);
    }

    const mainRange = mainChartRef.current?.timeScale().getVisibleRange();
    if (mainRange) {
      try { sub.timeScale().setVisibleRange(mainRange); } catch { /* no data yet */ }
    } else {
      sub.timeScale().fitContent();
    }
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
  // Persist chart state to localStorage on every relevant change
  // ---------------------------------------------------------------------------
  useEffect(() => {
    scSave({ pair, timeframe, dateFrom, dateTo, activeOsc, oscParams, chartOverlays, selectedStratId, selectedBtId });
  }, [pair, timeframe, dateFrom, dateTo, activeOsc, oscParams, chartOverlays, selectedStratId, selectedBtId]);

  // ---------------------------------------------------------------------------
  // Reset — clears localStorage and returns everything to defaults
  // ---------------------------------------------------------------------------
  async function loadLabIndicator(ind: {id:string;name:string;indicator_config:{indicators:{type:string;params:Record<string,unknown>;color?:string}[]}}) {
    if (loadedLabIndicators.find(l => l.id === ind.id)) {
      setLoadedLabIndicators(prev => prev.filter(l => l.id !== ind.id));
      return;
    }
    try {
      const res = await fetchWithAuth(`${API_BASE}/api/lab/indicators`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pair, timeframe, from: dateFrom, to: dateTo,
          indicators: ind.indicator_config.indicators,
        }),
      });
      if (!res.ok) return;
      const data = await res.json();
      setLoadedLabIndicators(prev => [...prev, { id: ind.id, name: ind.name, data: data.indicators ?? [] }]);
    } catch { /* non-fatal */ }
  }

  function handleReset() {
    scClear();
    setPair("EURUSD");
    setTimeframe("1H");
    setDateFrom(defaultDateFrom());
    setDateTo(defaultDateTo());
    setActiveOsc("RSI");
    setOscParams(DEFAULT_OSC_PARAMS);
    setChartOverlays([]);
    setSelectedBtId("");
    setTrades([]);
    if (strategies.length > 0) setSelectedStratId(strategies[0].id);
  }

  // ---------------------------------------------------------------------------
  // Derived state
  // ---------------------------------------------------------------------------
  const isModified = currentSIR && originalSIR
    ? JSON.stringify(currentSIR.entry_conditions) !== JSON.stringify(originalSIR.entry_conditions)
    : false;

  // Trades filtered to the diagnosis period window
  const diagTrades = diagPeriodStart && diagPeriodEnd
    ? trades.filter(t => {
        const ts = t.entry_time;
        return ts >= diagPeriodStart && ts <= diagPeriodEnd + "T23:59:59Z";
      })
    : trades;

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
      {diagPanelOpen && selectedBtId && (
        <div className="fixed inset-0 z-50 flex justify-end pointer-events-none">
          <div className="w-80 pointer-events-auto h-full shadow-2xl">
            <DiagnosisPanel
              backtestRunId={selectedBtId}
              periodStart={diagPeriodStart ? `${diagPeriodStart}T00:00:00Z` : new Date().toISOString()}
              periodEnd={diagPeriodEnd ? `${diagPeriodEnd}T23:59:59Z` : new Date().toISOString()}
              tradeCount={diagTrades.length}
              onClose={() => setDiagPanelOpen(false)}
            />
          </div>
        </div>
      )}
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
          <button
            onClick={() => router.push(`/lab?pair=${pair}&timeframe=${timeframe}`)}
            className="rounded border border-zinc-600 px-1.5 py-0.5 text-[10px] text-zinc-400 hover:bg-zinc-700/40 transition-colors ml-1"
          >
            Open in Lab
          </button>
          <button
            onClick={handleReset}
            className="rounded border border-zinc-600 px-1.5 py-0.5 text-[10px] text-zinc-400 hover:bg-zinc-700/40 transition-colors"
            title="Reset chart to defaults and clear saved state"
          >
            Reset
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

          {/* Sub oscillator chart */}
          <div
            ref={subDivRef}
            className="flex-shrink-0"
            style={{ height: 160 }}
          />

          {/* OSC tab bar with inline editable params — sits directly under the sub-chart */}
          <div className="flex items-center gap-0 px-2 py-1 border-t border-zinc-800 bg-zinc-900 flex-shrink-0 overflow-x-auto">
            <span className="text-[10px] text-zinc-600 mr-2 shrink-0">OSC</span>
            {(["RSI", "MACD", "ADX", "STOCH", "ATR"] as OscTab[]).map((tab, i) => {
              const isActive = activeOsc === tab;
              const inStrategy = oscillatorsInStrategy.includes(tab);
              const btnCls = [
                "text-[10px] px-1.5 py-0.5 rounded transition-colors shrink-0 font-medium",
                isActive ? "bg-blue-600 text-white" : inStrategy ? "bg-zinc-700 text-zinc-200 hover:bg-zinc-600" : "bg-zinc-800 text-zinc-500 hover:bg-zinc-700",
              ].join(" ");
              const numInput = (val: number, onCh: (v: number) => void) => (
                <Spinbox
                  value={val} min={1}
                  onChange={onCh}
                  onFocus={() => setActiveOsc(tab)}
                  onClick={(e) => e.stopPropagation()}
                  active={isActive}
                />
              );
              return (
                <div key={tab} className={`flex items-center gap-1 ${i > 0 ? "ml-2 pl-2 border-l border-zinc-700" : ""}`}>
                  <button onClick={() => setActiveOsc(tab)} className={btnCls}>{tab}</button>
                  {tab === "RSI"   && numInput(oscParams.RSI.period,           (v) => setOscParams((p) => ({ ...p, RSI: { period: v } })))}
                  {tab === "MACD"  && <div className="flex gap-1">
                    {numInput(oscParams.MACD.fast,          (v) => setOscParams((p) => ({ ...p, MACD: { ...p.MACD, fast: v } })))}
                    {numInput(oscParams.MACD.slow,          (v) => setOscParams((p) => ({ ...p, MACD: { ...p.MACD, slow: v } })))}
                    {numInput(oscParams.MACD.signal_period, (v) => setOscParams((p) => ({ ...p, MACD: { ...p.MACD, signal_period: v } })))}
                  </div>}
                  {tab === "ADX"   && numInput(oscParams.ADX.period,            (v) => setOscParams((p) => ({ ...p, ADX: { period: v } })))}
                  {tab === "STOCH" && <div className="flex gap-1">
                    {numInput(oscParams.STOCH.period,   (v) => setOscParams((p) => ({ ...p, STOCH: { ...p.STOCH, period: v } })))}
                    {numInput(oscParams.STOCH.k_smooth, (v) => setOscParams((p) => ({ ...p, STOCH: { ...p.STOCH, k_smooth: v } })))}
                    {numInput(oscParams.STOCH.d_period, (v) => setOscParams((p) => ({ ...p, STOCH: { ...p.STOCH, d_period: v } })))}
                  </div>}
                  {tab === "ATR"   && numInput(oscParams.ATR.period,            (v) => setOscParams((p) => ({ ...p, ATR: { period: v } })))}
                </div>
              );
            })}
          </div>
        </div>

        {/* ---------------------------------------------------------------- */}
        {/* Right control panel                                              */}
        {/* ---------------------------------------------------------------- */}
        <div className="w-52 flex-shrink-0 border-l border-zinc-800 flex flex-col overflow-y-auto">

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

          {/* Chart Indicators */}
          <Section title="Chart Indicators">
            <div className="flex gap-1 mb-2">
              <select
                value={newOverlayType}
                onChange={(e) => setNewOverlayType(e.target.value as IndicatorType)}
                className="flex-1 bg-zinc-800 text-zinc-200 text-xs rounded px-1.5 py-1 border border-zinc-700"
              >
                {ALL_INDICATORS.map((t) => (
                  <option key={t} value={t}>{t}{MAIN_INDICATORS.includes(t) ? "" : " (sub)"}</option>
                ))}
              </select>
              <button
                onClick={addOverlay}
                disabled={candles.length === 0}
                className="rounded border border-blue-700 px-2 py-1 text-[10px] text-blue-400 hover:bg-blue-900/30 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
              >
                + Add
              </button>
            </div>
            {chartOverlays.length === 0 ? (
              <p className="text-[10px] text-zinc-500">No indicators added. Load candles first.</p>
            ) : (
              <div className="space-y-2">
                {chartOverlays.map((ov) => (
                  <div key={ov.id} className="rounded border border-zinc-700 bg-zinc-800/60 px-2 py-1.5 space-y-1.5">
                    <div className="flex items-center gap-1.5">
                      <span className="inline-block w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: ov.color }} />
                      <span className="text-[11px] font-semibold text-zinc-200 flex-1">{ov.type}</span>
                      <button
                        onClick={() => removeOverlay(ov.id)}
                        className="text-zinc-500 hover:text-red-400 text-sm leading-none transition-colors"
                        title="Remove"
                      >×</button>
                    </div>
                    {/* Params */}
                    {ov.type !== "MACD" && ov.type !== "STOCH" && (
                      <div className="flex items-center gap-2">
                        <label className="text-[10px] text-zinc-500 w-10 shrink-0">Period</label>
                        <Spinbox value={ov.period} min={2} onChange={(v) => updateOverlay(ov.id, { period: v })} width="w-16" />
                        {ov.type === "BB" && (
                          <>
                            <label className="text-[10px] text-zinc-500 shrink-0">σ</label>
                            <Spinbox value={ov.std_dev} min={0.1} step={0.1} float onChange={(v) => updateOverlay(ov.id, { std_dev: v })} width="w-16" />
                          </>
                        )}
                      </div>
                    )}
                    {ov.type === "MACD" && (
                      <div className="grid grid-cols-3 gap-1">
                        {([["Fast", "fast", ov.fast], ["Slow", "slow", ov.slow], ["Sig", "signal_period", ov.signal_period]] as [string, keyof ChartOverlay, number][]).map(([lbl, key, val]) => (
                          <div key={key}>
                            <label className="text-[10px] text-zinc-500 block">{lbl}</label>
                            <Spinbox value={val} min={1} onChange={(v) => updateOverlay(ov.id, { [key]: v })} width="w-full" />
                          </div>
                        ))}
                      </div>
                    )}
                    {ov.type === "STOCH" && (
                      <div className="grid grid-cols-3 gap-1">
                        {([["K Prd", "period", ov.period], ["K Sm", "k_smooth", ov.k_smooth], ["D Prd", "d_period", ov.d_period]] as [string, keyof ChartOverlay, number][]).map(([lbl, key, val]) => (
                          <div key={key}>
                            <label className="text-[10px] text-zinc-500 block">{lbl}</label>
                            <Spinbox value={val} min={1} onChange={(v) => updateOverlay(ov.id, { [key]: v })} width="w-full" />
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </Section>

          {/* Lab Saved Indicators */}
          <Section title="Saved Indicators">
            {savedLabIndicators.length === 0 ? (
              <p className="text-[10px] text-zinc-500">No saved indicators. Build one in Indicator Lab.</p>
            ) : (
              <div className="space-y-1.5">
                {savedLabIndicators.map((ind) => {
                  const isLoaded = loadedLabIndicators.some(l => l.id === ind.id);
                  return (
                    <div key={ind.id} className={[
                      "flex items-center gap-1.5 rounded border px-2 py-1",
                      isLoaded ? "border-blue-700 bg-blue-900/10" : "border-zinc-700",
                    ].join(" ")}>
                      <span className={`text-[10px] shrink-0 ${ind.status === "complete" ? "text-zinc-200" : "text-zinc-500"}`}>
                        {ind.status === "complete" ? "●" : "○"}
                      </span>
                      <span className="text-[10px] text-zinc-300 flex-1 truncate" title={ind.name}>{ind.name}</span>
                      <button
                        onClick={() => loadLabIndicator(ind)}
                        className={[
                          "shrink-0 rounded border px-1.5 py-0.5 text-[10px] transition-colors",
                          isLoaded
                            ? "border-blue-700 text-blue-400 hover:bg-blue-900/30"
                            : "border-zinc-600 text-zinc-400 hover:bg-zinc-700/40",
                        ].join(" ")}
                      >
                        {isLoaded ? "Unload" : "Load"}
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </Section>

          {/* Period Diagnosis */}
          {selectedBtId && (
            <Section title="Period Diagnosis">
              <div className="space-y-1.5">
                <div className="grid grid-cols-2 gap-x-2 gap-y-0.5">
                  <div>
                    <label className="text-[10px] text-zinc-500 leading-none block mb-0.5">From</label>
                    <input
                      type="date"
                      value={diagPeriodStart}
                      onChange={e => { setDiagPeriodStart(e.target.value); setDiagPanelOpen(false); }}
                      className="w-full bg-zinc-800 border border-zinc-600 rounded px-1.5 py-0.5 text-xs text-zinc-200"
                    />
                  </div>
                  <div>
                    <label className="text-[10px] text-zinc-500 leading-none block mb-0.5">To</label>
                    <input
                      type="date"
                      value={diagPeriodEnd}
                      onChange={e => { setDiagPeriodEnd(e.target.value); setDiagPanelOpen(false); }}
                      className="w-full bg-zinc-800 border border-zinc-600 rounded px-1.5 py-0.5 text-xs text-zinc-200"
                    />
                  </div>
                </div>
                {diagTrades.length > 0 && (
                  <p className="text-[10px] text-zinc-500">
                    {diagTrades.length} trade{diagTrades.length !== 1 ? "s" : ""} in window
                  </p>
                )}
                <button
                  disabled={diagTrades.length < 2 || !diagPeriodStart || !diagPeriodEnd}
                  onClick={() => setDiagPanelOpen(true)}
                  className="w-full rounded border border-blue-700 px-2 py-1 text-[10px] text-blue-400 hover:bg-blue-900/30 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                >
                  {diagTrades.length < 2 ? "Select a period with ≥ 2 trades" : `Diagnose this period (${diagTrades.length} trades)`}
                </button>
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
        <Spinbox value={cond.period ?? 14} min={2} max={500} onChange={(v) => onChange({ period: v })} width="w-20" />
      </Label>

      {/* MACD fast/slow/signal */}
      {ind === "MACD" && (
        <>
          <Label label="Fast">
            <Spinbox value={cond.fast ?? 12} min={2} max={200} onChange={(v) => onChange({ fast: v })} width="w-20" />
          </Label>
          <Label label="Slow">
            <Spinbox value={cond.slow ?? 26} min={2} max={500} onChange={(v) => onChange({ slow: v })} width="w-20" />
          </Label>
          <Label label="Signal">
            <Spinbox value={cond.signal_period ?? 9} min={2} max={100} onChange={(v) => onChange({ signal_period: v })} width="w-20" />
          </Label>
        </>
      )}

      {/* BB std_dev */}
      {ind === "BB" && (
        <Label label="Std Dev">
          <Spinbox value={cond.std_dev ?? 2.0} min={0.5} max={5} step={0.1} float onChange={(v) => onChange({ std_dev: v })} width="w-20" />
        </Label>
      )}

      {/* Stochastic k_smooth / d_period */}
      {ind === "STOCH" && (
        <>
          <Label label="K Smooth">
            <Spinbox value={cond.k_smooth ?? 3} min={1} max={50} onChange={(v) => onChange({ k_smooth: v })} width="w-20" />
          </Label>
          <Label label="D Period">
            <Spinbox value={cond.d_period ?? 3} min={1} max={50} onChange={(v) => onChange({ d_period: v })} width="w-20" />
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

