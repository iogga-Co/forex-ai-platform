"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  createChart, CrosshairMode, IChartApi, ISeriesApi,
  LineStyle, LineWidth, Time,
} from "lightweight-charts";
import { fetchWithAuth } from "@/lib/auth";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
type IndType    = "EMA"|"SMA"|"BB"|"RSI"|"MACD"|"ADX"|"STOCH"|"ATR";
type OscTab     = "RSI"|"MACD"|"ADX"|"STOCH"|"ATR";
type PanelView  = "builder"|"library";

interface LabIndicator {
  id: string; type: IndType; color: string;
  period: number; fast: number; slow: number; signal_period: number;
  std_dev: number; k_smooth: number; d_period: number;
}

interface LabCondition {
  id: string; indicator: string; operator: string; period: number; value: number;
}

interface SavedIndicator {
  id: string; name: string; status: "draft"|"complete";
  indicator_config: { indicators: { type: string; params: Record<string,unknown>; color?: string }[] };
  signal_conditions: LabCondition[];
  updated_at: string;
}

interface SeriesData { name: string; color: string; data: {time:number;value:number}[]; style?: string; }
interface IndicatorGroup { id: string; type: string; pane: string; levels?: {value:number;color:string}[]; series: SeriesData[]; }
interface Candle { time: number; open: number; high: number; low: number; close: number; }

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const API_BASE   = process.env.NEXT_PUBLIC_API_URL ?? "";
const PAIRS      = ["EURUSD","GBPUSD","USDJPY","EURGBP","GBPJPY","USDCHF"];
const TIMEFRAMES = ["1m","5m","15m","30m","1H","4H","1D"];
const ALL_TYPES: IndType[] = ["EMA","SMA","BB","RSI","MACD","ADX","STOCH","ATR"];
const OSC_TYPES  = new Set<string>(["RSI","MACD","ADX","STOCH","ATR"]);
const COLORS     = ["#3b82f6","#f59e0b","#a855f7","#06b6d4","#f97316","#10b981","#ec4899","#facc15"];
const OPERATORS  = [">","<","price_above","price_below","crossed_above","crossed_below"];

const CHART_THEME = {
  bg:"#09090b", text:"#a1a1aa", grid:"#1c1c1f", border:"#27272a", up:"#22c55e", down:"#ef4444",
};

const DEFAULTS: Record<IndType, Partial<LabIndicator>> = {
  EMA:{period:20}, SMA:{period:50}, BB:{period:20,std_dev:2.0},
  RSI:{period:14}, MACD:{fast:12,slow:26,signal_period:9,period:12},
  ADX:{period:14}, STOCH:{period:14,k_smooth:3,d_period:3}, ATR:{period:14},
};

let _uid = 0;
const uid = () => `i${++_uid}`;

function defaultFrom() {
  const d = new Date(); d.setFullYear(d.getFullYear()-1); return d.toISOString().slice(0,10);
}
function defaultTo() { return new Date().toISOString().slice(0,10); }

// ---------------------------------------------------------------------------
// Lab state persistence
// ---------------------------------------------------------------------------
const LAB_KEY = "lab_state";
interface PersistedLab {
  pair: string; timeframe: string; dateFrom: string; dateTo: string;
  indicators: LabIndicator[]; conditions: LabCondition[];
}
function labLoad(): Partial<PersistedLab> {
  try { return JSON.parse(localStorage.getItem(LAB_KEY) ?? "{}"); } catch { return {}; }
}
function labSave(s: PersistedLab) {
  try { localStorage.setItem(LAB_KEY, JSON.stringify(s)); } catch {}
}
function labClear() {
  try { localStorage.removeItem(LAB_KEY); } catch {}
}

function makeChart(el: HTMLDivElement, h: number, hideTime = false): IChartApi {
  return createChart(el, {
    width: el.clientWidth, height: h,
    layout: { background:{color:CHART_THEME.bg}, textColor:CHART_THEME.text },
    grid: { vertLines:{color:CHART_THEME.grid}, horzLines:{color:CHART_THEME.grid} },
    crosshair: { mode: CrosshairMode.Normal },
    rightPriceScale: { borderColor: CHART_THEME.border },
    timeScale: { borderColor:CHART_THEME.border, timeVisible:true, secondsVisible:false, visible:!hideTime },
  });
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------
export default function LabPage() { return <Suspense><LabInner /></Suspense>; }

function LabInner() {
  const router       = useRouter();
  const searchParams = useSearchParams();

  // Controls — restored from localStorage; URL params take priority
  const [pair,      setPair]      = useState(() => searchParams.get("pair")      ?? labLoad().pair      ?? "EURUSD");
  const [timeframe, setTimeframe] = useState(() => searchParams.get("timeframe") ?? labLoad().timeframe ?? "1H");
  const [dateFrom,  setDateFrom]  = useState(() => labLoad().dateFrom ?? defaultFrom());
  const [dateTo,    setDateTo]    = useState(() => labLoad().dateTo   ?? defaultTo());

  // Data
  const [candles,        setCandles]        = useState<Candle[]>([]);
  const [loadingCandles, setLoadingCandles] = useState(false);
  const [indicatorData,  setIndicatorData]  = useState<IndicatorGroup[]>([]);
  const [signals,        setSignals]        = useState<number[]>([]);
  const [computing,      setComputing]      = useState(false);

  // Builder — restored from localStorage
  const [indicators, setIndicators] = useState<LabIndicator[]>(() => labLoad().indicators ?? []);
  const [conditions, setConditions] = useState<LabCondition[]>(() => labLoad().conditions ?? []);
  const [newIndType, setNewIndType] = useState<IndType>("EMA");
  const [newCondInd, setNewCondInd] = useState("RSI");
  const [newCondOp,  setNewCondOp]  = useState(">");
  const [newCondPer, setNewCondPer] = useState(14);
  const [newCondVal, setNewCondVal] = useState(70);
  const [activeOsc,  setActiveOsc]  = useState<OscTab>("RSI");

  // Panel view
  const [panelView, setPanelView] = useState<PanelView>("builder");

  // Library
  const [savedIndicators,  setSavedIndicators]  = useState<SavedIndicator[]>([]);
  const [libraryLoaded,    setLibraryLoaded]    = useState<{id:string;name:string;data:IndicatorGroup[]}[]>([]);
  const [deletingId,       setDeletingId]       = useState<string|null>(null);

  // Save form
  const [indName,   setIndName]   = useState("");
  const [indStatus, setIndStatus] = useState<"draft"|"complete">("draft");
  const [saving,    setSaving]    = useState(false);
  const [saveMsg,   setSaveMsg]   = useState("");
  const [exporting, setExporting] = useState(false);

  // Chart refs
  const mainDivRef    = useRef<HTMLDivElement>(null);
  const subDivRef     = useRef<HTMLDivElement>(null);
  const mainChart     = useRef<IChartApi|null>(null);
  const subChart      = useRef<IChartApi|null>(null);
  const candleSeries  = useRef<ISeriesApi<"Candlestick">|null>(null);
  const overlayRefs   = useRef<ISeriesApi<"Line">[]>([]);
  const subRefs       = useRef<ISeriesApi<"Line"|"Histogram">[]>([]);
  const libRefs       = useRef<ISeriesApi<"Line">[]>([]);
  const syncingRef    = useRef(false);
  const recomputeTimer = useRef<ReturnType<typeof setTimeout>|null>(null);

  // ---------------------------------------------------------------------------
  // Init charts
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (!mainDivRef.current || !subDivRef.current) return;
    const main = makeChart(mainDivRef.current, mainDivRef.current.clientHeight);
    const sub  = makeChart(subDivRef.current,  subDivRef.current.clientHeight, false);
    const cs   = main.addCandlestickSeries({
      upColor:CHART_THEME.up, downColor:CHART_THEME.down,
      borderUpColor:CHART_THEME.up, borderDownColor:CHART_THEME.down,
      wickUpColor:CHART_THEME.up, wickDownColor:CHART_THEME.down,
    });
    mainChart.current = main; subChart.current = sub; candleSeries.current = cs;

    main.timeScale().subscribeVisibleTimeRangeChange(range => {
      if (syncingRef.current || !range) return;
      syncingRef.current = true;
      try { sub.timeScale().setVisibleRange(range); } catch {}
      syncingRef.current = false;
    });
    sub.timeScale().subscribeVisibleTimeRangeChange(range => {
      if (syncingRef.current || !range) return;
      syncingRef.current = true;
      try { main.timeScale().setVisibleRange(range); } catch {}
      syncingRef.current = false;
    });

    const ro = new ResizeObserver(() => {
      if (mainDivRef.current) main.applyOptions({ width: mainDivRef.current.clientWidth });
      if (subDivRef.current)  sub.applyOptions({ width: subDivRef.current.clientWidth });
    });
    if (mainDivRef.current) ro.observe(mainDivRef.current);
    if (subDivRef.current)  ro.observe(subDivRef.current);

    return () => {
      ro.disconnect(); main.remove(); sub.remove();
      mainChart.current = null; subChart.current = null; candleSeries.current = null;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------------------------------------------------------------------------
  // Load saved indicators list
  // ---------------------------------------------------------------------------
  useEffect(() => {
    fetchWithAuth(`${API_BASE}/api/lab/indicators/saved`)
      .then(r => r.ok ? r.json() : [])
      .then(setSavedIndicators)
      .catch(() => {});
  }, []);

  // ---------------------------------------------------------------------------
  // Load candles
  // ---------------------------------------------------------------------------
  const loadCandles = useCallback(async (p:string, tf:string, from:string, to:string) => {
    setLoadingCandles(true);
    try {
      const res = await fetchWithAuth(
        `${API_BASE}/api/candles?pair=${p}&timeframe=${tf}&start=${from}&end=${to}&limit=5000`
      );
      if (!res.ok) throw new Error();
      const data = await res.json();
      setCandles(data.candles ?? []);
    } catch { setCandles([]); }
    finally { setLoadingCandles(false); }
  }, []);

  useEffect(() => {
    if (dateFrom && dateTo) loadCandles(pair, timeframe, dateFrom, dateTo);
  }, [pair, timeframe, dateFrom, dateTo, loadCandles]);

  // ---------------------------------------------------------------------------
  // Render candles
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (!candleSeries.current || candles.length === 0) return;
    candleSeries.current.setData(
      candles.map(c => ({ time:c.time as Time, open:c.open, high:c.high, low:c.low, close:c.close }))
    );
    mainChart.current?.timeScale().fitContent();
  }, [candles]);

  // ---------------------------------------------------------------------------
  // Compute indicators + signals
  // ---------------------------------------------------------------------------
  const recompute = useCallback(async (
    inds: LabIndicator[], conds: LabCondition[],
    p: string, tf: string, from: string, to: string
  ) => {
    if (inds.length === 0) { setIndicatorData([]); setSignals([]); return; }
    setComputing(true);
    try {
      const payload = {
        pair:p, timeframe:tf, from, to,
        indicators: inds.map(i => ({
          type: i.type, color: i.color,
          params: { period:i.period, fast:i.fast, slow:i.slow, signal_period:i.signal_period,
                    std_dev:i.std_dev, k_smooth:i.k_smooth, d_period:i.d_period },
        })),
      };
      const res = await fetchWithAuth(`${API_BASE}/api/lab/indicators`, {
        method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(payload),
      });
      if (res.ok) { const d = await res.json(); setIndicatorData(d.indicators ?? []); }

      if (conds.length > 0) {
        const sr = await fetchWithAuth(`${API_BASE}/api/lab/signals`, {
          method:"POST", headers:{"Content-Type":"application/json"},
          body: JSON.stringify({ ...payload, conditions: conds.map(c => ({
            indicator:c.indicator, operator:c.operator, period:c.period, value:c.value,
          })) }),
        });
        if (sr.ok) { const s = await sr.json(); setSignals(s.signals ?? []); }
      } else {
        setSignals([]);
      }
    } catch { /* non-fatal */ }
    finally { setComputing(false); }
  }, []);

  // Persist builder state to localStorage
  useEffect(() => {
    labSave({ pair, timeframe, dateFrom, dateTo, indicators, conditions });
  }, [pair, timeframe, dateFrom, dateTo, indicators, conditions]);

  function handleLabReset() {
    labClear();
    setPair("EURUSD"); setTimeframe("1H");
    setDateFrom(defaultFrom()); setDateTo(defaultTo());
    setIndicators([]); setConditions([]);
    setIndicatorData([]); setSignals([]);
  }

  function scheduleRecompute(inds: LabIndicator[], conds: LabCondition[]) {
    if (recomputeTimer.current) clearTimeout(recomputeTimer.current);
    recomputeTimer.current = setTimeout(() => {
      recompute(inds, conds, pair, timeframe, dateFrom, dateTo);
    }, 300);
  }

  useEffect(() => {
    if (candles.length > 0) recompute(indicators, conditions, pair, timeframe, dateFrom, dateTo);
  }, [candles]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------------------------------------------------------------------------
  // Render builder indicator series
  // ---------------------------------------------------------------------------
  useEffect(() => {
    const main = mainChart.current; const sub = subChart.current;
    if (!main || !sub) return;
    overlayRefs.current.forEach(s => { try { main.removeSeries(s); } catch {} });
    overlayRefs.current = [];
    subRefs.current.forEach(s => { try { sub.removeSeries(s); } catch {} });
    subRefs.current = [];

    for (const group of indicatorData) {
      if (group.pane === "overlay") {
        for (const series of group.series) {
          const s = main.addLineSeries({ color:series.color, lineWidth:1 as LineWidth,
            lineStyle: group.type==="SMA" ? LineStyle.Dashed : LineStyle.Solid,
            priceLineVisible:false, lastValueVisible:false, title:series.name });
          s.setData(series.data as {time:Time;value:number}[]);
          overlayRefs.current.push(s);
        }
      } else if (group.type === activeOsc) {
        for (const series of group.series) {
          if (series.style === "histogram") {
            const s = sub.addHistogramSeries({ priceLineVisible:false, title:series.name });
            s.setData(series.data as {time:Time;value:number;color?:string}[]);
            subRefs.current.push(s);
          } else {
            const s = sub.addLineSeries({ color:series.color, lineWidth:1 as LineWidth,
              priceLineVisible:false, lastValueVisible:false, title:series.name });
            s.setData(series.data as {time:Time;value:number}[]);
            if (subRefs.current.length === 0) {
              group.levels?.forEach(lvl => s.createPriceLine({
                price:lvl.value, color:lvl.color, lineWidth:1 as LineWidth,
                lineStyle:LineStyle.Dashed, axisLabelVisible:true, title:String(lvl.value),
              }));
            }
            subRefs.current.push(s);
          }
        }
      }
    }
    const range = mainChart.current?.timeScale().getVisibleRange();
    if (range) { try { sub.timeScale().setVisibleRange(range); } catch {} }
  }, [indicatorData, activeOsc]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------------------------------------------------------------------------
  // Render library overlay series (dashed, distinguishable from builder)
  // ---------------------------------------------------------------------------
  useEffect(() => {
    const main = mainChart.current;
    if (!main) return;
    libRefs.current.forEach(s => { try { main.removeSeries(s); } catch {} });
    libRefs.current = [];
    for (const loaded of libraryLoaded) {
      for (const group of loaded.data) {
        if (group.pane !== "overlay") continue;
        for (const series of group.series) {
          const s = main.addLineSeries({ color:series.color, lineWidth:1 as LineWidth,
            lineStyle:LineStyle.Dotted, priceLineVisible:false, lastValueVisible:false,
            title:`[${loaded.name}] ${series.name}` });
          s.setData(series.data as {time:Time;value:number}[]);
          libRefs.current.push(s);
        }
      }
    }
  }, [libraryLoaded]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------------------------------------------------------------------------
  // Signal markers
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (!candleSeries.current) return;
    candleSeries.current.setMarkers(
      signals.map(ts => ({
        time:ts as Time, position:"belowBar" as const, color:"#22c55e", shape:"arrowUp" as const, text:"▲",
      })).sort((a,b) => (a.time as number)-(b.time as number))
    );
  }, [signals]);

  // ---------------------------------------------------------------------------
  // Builder helpers
  // ---------------------------------------------------------------------------
  function addIndicator() {
    const color = COLORS[indicators.length % COLORS.length];
    const ind: LabIndicator = {
      id:uid(), type:newIndType, color,
      period:14, fast:12, slow:26, signal_period:9, std_dev:2.0, k_smooth:3, d_period:3,
      ...DEFAULTS[newIndType],
    };
    const next = [...indicators, ind];
    setIndicators(next);
    scheduleRecompute(next, conditions);
  }

  function updateIndicator(id: string, patch: Partial<LabIndicator>) {
    const next = indicators.map(i => i.id===id ? {...i,...patch} : i);
    setIndicators(next);
    scheduleRecompute(next, conditions);
  }

  function removeIndicator(id: string) {
    const next = indicators.filter(i => i.id!==id);
    setIndicators(next);
    scheduleRecompute(next, conditions);
  }

  function addCondition() {
    const next = [...conditions, {id:uid(), indicator:newCondInd, operator:newCondOp, period:newCondPer, value:newCondVal}];
    setConditions(next);
    scheduleRecompute(indicators, next);
  }

  function removeCondition(id: string) {
    const next = conditions.filter(c => c.id!==id);
    setConditions(next);
    scheduleRecompute(indicators, next);
  }

  // ---------------------------------------------------------------------------
  // Save as Indicator
  // ---------------------------------------------------------------------------
  async function saveIndicator() {
    if (indicators.length === 0) return;
    setSaving(true); setSaveMsg("");
    try {
      const name = indName.trim() || suggestedName;
      const res = await fetchWithAuth(`${API_BASE}/api/lab/indicators/saved`, {
        method:"POST", headers:{"Content-Type":"application/json"},
        body: JSON.stringify({
          name, status: indStatus,
          indicator_config: {
            indicators: indicators.map(i => ({
              type:i.type, color:i.color,
              params: { period:i.period, fast:i.fast, slow:i.slow, signal_period:i.signal_period,
                        std_dev:i.std_dev, k_smooth:i.k_smooth, d_period:i.d_period },
            })),
          },
          signal_conditions: conditions.map(({id:_,...c}) => c),
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const saved: SavedIndicator = await res.json();
      setSavedIndicators(prev => [saved, ...prev]);
      setSaveMsg("Saved ✓");
      setTimeout(() => setSaveMsg(""), 3000);
    } catch (e) {
      setSaveMsg(e instanceof Error ? e.message : "Save failed");
    } finally { setSaving(false); }
  }

  // ---------------------------------------------------------------------------
  // Export as Strategy
  // ---------------------------------------------------------------------------
  async function exportStrategy() {
    if (conditions.length === 0) return;
    setExporting(true);
    try {
      const entry_conditions = conditions.map(c => ({
        indicator: c.indicator, period: c.period, operator: c.operator,
        ...([">" ,"<"].includes(c.operator) ? { value: c.value } : {}),
      }));
      const sir = {
        entry_conditions,
        exit_conditions: {
          stop_loss:   { type:"atr", period:14, multiplier:1.5 },
          take_profit: { type:"atr", period:14, multiplier:3.0 },
        },
        filters: { exclude_days:[], session:"all" },
        position_sizing: { risk_per_trade_pct:1.0, max_size_units:100000 },
      };
      const res = await fetchWithAuth(`${API_BASE}/api/strategies`, {
        method:"POST", headers:{"Content-Type":"application/json"},
        body: JSON.stringify({
          ir_json: sir,
          description: indName.trim() || suggestedName,
          pair, timeframe,
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const strategy = await res.json();
      router.push(`/backtest?strategy_id=${strategy.id}&pair=${pair}&timeframe=${timeframe}`);
    } catch (e) {
      setSaveMsg(e instanceof Error ? e.message : "Export failed");
    } finally { setExporting(false); }
  }

  // ---------------------------------------------------------------------------
  // Library: load indicator onto chart
  // ---------------------------------------------------------------------------
  async function loadLibraryIndicator(ind: SavedIndicator) {
    if (libraryLoaded.find(l => l.id===ind.id)) {
      // Already loaded — remove it
      setLibraryLoaded(prev => prev.filter(l => l.id!==ind.id));
      return;
    }
    try {
      const res = await fetchWithAuth(`${API_BASE}/api/lab/indicators`, {
        method:"POST", headers:{"Content-Type":"application/json"},
        body: JSON.stringify({
          pair, timeframe, from:dateFrom, to:dateTo,
          indicators: ind.indicator_config.indicators,
        }),
      });
      if (!res.ok) return;
      const data = await res.json();
      setLibraryLoaded(prev => [...prev, { id:ind.id, name:ind.name, data:data.indicators??[] }]);
    } catch { /* non-fatal */ }
  }

  // ---------------------------------------------------------------------------
  // Library: delete saved indicator
  // ---------------------------------------------------------------------------
  async function deleteSaved(id: string) {
    setDeletingId(id);
    try {
      await fetchWithAuth(`${API_BASE}/api/lab/indicators/saved/${id}`, { method:"DELETE" });
      setSavedIndicators(prev => prev.filter(i => i.id!==id));
      setLibraryLoaded(prev => prev.filter(l => l.id!==id));
    } catch { /* non-fatal */ }
    finally { setDeletingId(null); }
  }

  // ---------------------------------------------------------------------------
  // Derived
  // ---------------------------------------------------------------------------
  const uniqueOscTypes = [...new Set(indicators.filter(i => OSC_TYPES.has(i.type)).map(i => i.type))] as OscTab[];
  const suggestedName  = indicators.length > 0
    ? `[Lab] ${indicators.map(i=>i.type).join("+")} ${pair} ${timeframe}`
    : `[Lab] ${pair} ${timeframe}`;

  const iCls = "bg-zinc-800 border border-zinc-700 rounded px-1 py-0.5 text-[11px] text-zinc-200 text-right no-spinner";
  const sCls = "bg-zinc-800 border border-zinc-700 rounded px-1 py-0.5 text-[11px] text-zinc-200";
  const lCls = "text-[10px] text-zinc-500";

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------
  return (
    <div className="flex flex-col h-full overflow-hidden -m-1 bg-[#09090b] text-zinc-200">

      {/* Toolbar */}
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-zinc-800 shrink-0 flex-wrap">
        <span className="text-[11px] font-semibold text-zinc-400 uppercase tracking-wider mr-1">Indicator Lab</span>
        <select value={pair} onChange={e => setPair(e.target.value)}
          className="bg-zinc-800 text-zinc-200 text-xs rounded px-2 py-1 border border-zinc-700">
          {PAIRS.map(p => <option key={p}>{p}</option>)}
        </select>
        <select value={timeframe} onChange={e => setTimeframe(e.target.value)}
          className="bg-zinc-800 text-zinc-200 text-xs rounded px-2 py-1 border border-zinc-700">
          {TIMEFRAMES.map(t => <option key={t}>{t}</option>)}
        </select>
        <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)}
          className="bg-zinc-800 text-zinc-200 text-xs rounded px-2 py-1 border border-zinc-700" />
        <span className="text-zinc-600 text-xs">→</span>
        <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)}
          className="bg-zinc-800 text-zinc-200 text-xs rounded px-2 py-1 border border-zinc-700" />
        {loadingCandles && <span className="text-[10px] text-zinc-500 animate-pulse">Loading…</span>}
        {computing      && <span className="text-[10px] text-blue-400 animate-pulse">Computing…</span>}
        {candles.length > 0 && !loadingCandles && (
          <span className="text-[10px] text-zinc-600">{candles.length.toLocaleString()} bars</span>
        )}
        <button
          onClick={handleLabReset}
          className="ml-auto rounded border border-zinc-600 px-1.5 py-0.5 text-[10px] text-zinc-400 hover:bg-zinc-700/40 transition-colors"
          title="Reset builder to defaults and clear saved state"
        >
          Reset
        </button>
      </div>

      <div className="flex flex-1 overflow-hidden">

        {/* Left panel */}
        <div className="w-52 shrink-0 border-r border-zinc-800 flex flex-col overflow-hidden">

          {/* Panel tab toggle */}
          <div className="flex border-b border-zinc-800 shrink-0">
            {(["builder","library"] as PanelView[]).map(v => (
              <button key={v} onClick={() => setPanelView(v)}
                className={[
                  "flex-1 py-1.5 text-[10px] font-semibold uppercase tracking-wider transition-colors",
                  panelView===v ? "bg-zinc-800 text-zinc-200" : "text-zinc-500 hover:text-zinc-300",
                ].join(" ")}>
                {v}
                {v==="library" && savedIndicators.length > 0 && (
                  <span className="ml-1 text-zinc-600">({savedIndicators.length})</span>
                )}
              </button>
            ))}
          </div>

          {/* ── Builder view ────────────────────────────────────── */}
          {panelView === "builder" && (
            <div className="flex flex-col flex-1 overflow-y-auto">

              {/* Indicators */}
              <div className="border-b border-zinc-800 px-3 py-2">
                <div className={`${lCls} font-semibold uppercase tracking-widest mb-2`}>Indicators</div>
                <div className="flex gap-1 mb-2">
                  <select value={newIndType} onChange={e => setNewIndType(e.target.value as IndType)} className={`${sCls} flex-1`}>
                    {ALL_TYPES.map(t => <option key={t}>{t}</option>)}
                  </select>
                  <button onClick={addIndicator} disabled={candles.length===0}
                    className="rounded border border-blue-700 px-2 py-0.5 text-[10px] text-blue-400 hover:bg-blue-900/30 disabled:opacity-30 disabled:cursor-not-allowed transition-colors">
                    + Add
                  </button>
                </div>

                {indicators.length === 0 ? (
                  <p className="text-[10px] text-zinc-600">Load candles then add indicators.</p>
                ) : (
                  <div className="space-y-2">
                    {indicators.map(ind => (
                      <div key={ind.id} className="rounded border border-zinc-700 bg-zinc-800/60 px-2 py-1.5 space-y-1">
                        <div className="flex items-center gap-1.5">
                          <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{backgroundColor:ind.color}} />
                          <span className="text-[11px] font-semibold text-zinc-200 flex-1">{ind.type}</span>
                          <button onClick={() => removeIndicator(ind.id)} className="text-zinc-500 hover:text-red-400 text-sm leading-none">×</button>
                        </div>
                        {ind.type==="MACD" ? (
                          <div className="grid grid-cols-3 gap-1">
                            {(["fast","slow","signal_period"] as const).map(k => (
                              <div key={k}>
                                <div className={lCls}>{k==="signal_period"?"sig":k}</div>
                                <input type="number" min={1} value={ind[k]}
                                  onChange={e => updateIndicator(ind.id,{[k]:Math.max(1,parseInt(e.target.value)||1)})}
                                  className={`${iCls} w-full`} />
                              </div>
                            ))}
                          </div>
                        ) : ind.type==="STOCH" ? (
                          <div className="grid grid-cols-3 gap-1">
                            {(["period","k_smooth","d_period"] as const).map(k => (
                              <div key={k}>
                                <div className={lCls}>{k==="k_smooth"?"Ksm":k==="d_period"?"Dpr":"per"}</div>
                                <input type="number" min={1} value={ind[k]}
                                  onChange={e => updateIndicator(ind.id,{[k]:Math.max(1,parseInt(e.target.value)||1)})}
                                  className={`${iCls} w-full`} />
                              </div>
                            ))}
                          </div>
                        ) : ind.type==="BB" ? (
                          <div className="flex gap-2">
                            <div className="flex-1">
                              <div className={lCls}>period</div>
                              <input type="number" min={2} value={ind.period}
                                onChange={e => updateIndicator(ind.id,{period:Math.max(2,parseInt(e.target.value)||2)})}
                                className={`${iCls} w-full`} />
                            </div>
                            <div className="flex-1">
                              <div className={lCls}>σ</div>
                              <input type="number" min={0.1} step={0.1} value={ind.std_dev}
                                onChange={e => updateIndicator(ind.id,{std_dev:Math.max(0.1,parseFloat(e.target.value)||2)})}
                                className={`${iCls} w-full`} />
                            </div>
                          </div>
                        ) : (
                          <div>
                            <div className={lCls}>period</div>
                            <input type="number" min={1} value={ind.period}
                              onChange={e => updateIndicator(ind.id,{period:Math.max(1,parseInt(e.target.value)||1)})}
                              className={`${iCls} w-24`} />
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Signal Conditions */}
              <div className="border-b border-zinc-800 px-3 py-2">
                <div className={`${lCls} font-semibold uppercase tracking-widest mb-2`}>
                  Signal Conditions
                  {signals.length > 0 && <span className="ml-1.5 text-green-500 normal-case font-normal">{signals.length} signals</span>}
                </div>
                <div className="space-y-1 mb-2">
                  <div className="flex gap-1">
                    <select value={newCondInd} onChange={e => setNewCondInd(e.target.value)} className={`${sCls} flex-1`}>
                      {ALL_TYPES.map(t => <option key={t}>{t}</option>)}
                    </select>
                    <select value={newCondOp} onChange={e => setNewCondOp(e.target.value)} className={`${sCls} flex-1`}>
                      {OPERATORS.map(o => <option key={o}>{o}</option>)}
                    </select>
                  </div>
                  <div className="flex gap-1 items-center">
                    <span className={`${lCls} shrink-0`}>per</span>
                    <input type="number" min={1} value={newCondPer}
                      onChange={e => setNewCondPer(Math.max(1,parseInt(e.target.value)||1))}
                      className={`${iCls} w-12`} />
                    {[">" ,"<"].includes(newCondOp) && <>
                      <span className={`${lCls} shrink-0`}>val</span>
                      <input type="number" value={newCondVal}
                        onChange={e => setNewCondVal(parseFloat(e.target.value)||0)}
                        className={`${iCls} w-12`} />
                    </>}
                  </div>
                  <button onClick={addCondition}
                    className="w-full rounded border border-zinc-600 px-1.5 py-0.5 text-[10px] text-zinc-400 hover:bg-zinc-700/40 transition-colors">
                    + Add Condition
                  </button>
                </div>
                {conditions.map(c => (
                  <div key={c.id} className="flex items-center justify-between text-[10px] py-0.5">
                    <span className="text-zinc-300">
                      {c.indicator}({c.period}) {c.operator}{[">" ,"<"].includes(c.operator) ? ` ${c.value}` : ""}
                    </span>
                    <button onClick={() => removeCondition(c.id)} className="text-zinc-600 hover:text-red-400 ml-1">×</button>
                  </div>
                ))}
              </div>

              {/* Save / Export */}
              <div className="px-3 py-2 space-y-2">
                <div className={`${lCls} font-semibold uppercase tracking-widest`}>Save</div>

                <input
                  type="text"
                  placeholder={suggestedName}
                  value={indName}
                  onChange={e => setIndName(e.target.value)}
                  className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-[11px] text-zinc-200 placeholder-zinc-600"
                />

                <div className="flex items-center gap-3">
                  {(["draft","complete"] as const).map(s => (
                    <label key={s} className="flex items-center gap-1 cursor-pointer">
                      <input type="radio" name="ind_status" value={s} className="accent-blue-500"
                        checked={indStatus===s} onChange={() => setIndStatus(s)} />
                      <span className="text-[10px] text-zinc-300 capitalize">{s}</span>
                    </label>
                  ))}
                </div>

                <button onClick={saveIndicator} disabled={saving || indicators.length===0}
                  className="w-full rounded border border-blue-700 px-2 py-1 text-[10px] text-blue-400 hover:bg-blue-900/30 disabled:opacity-30 disabled:cursor-not-allowed transition-colors">
                  {saving ? "Saving…" : "Save as Indicator"}
                </button>

                <button onClick={exportStrategy} disabled={exporting || conditions.length===0}
                  className="w-full rounded border border-zinc-600 px-2 py-1 text-[10px] text-zinc-400 hover:bg-zinc-700/40 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                  title={conditions.length===0 ? "Add signal conditions to export" : undefined}>
                  {exporting ? "Exporting…" : "Export as Strategy →"}
                </button>

                {saveMsg && (
                  <p className={`text-[10px] ${saveMsg.includes("✓") ? "text-green-400" : "text-red-400"}`}>{saveMsg}</p>
                )}
              </div>
            </div>
          )}

          {/* ── Library view ─────────────────────────────────── */}
          {panelView === "library" && (
            <div className="flex flex-col flex-1 overflow-y-auto px-3 py-2">
              <div className={`${lCls} font-semibold uppercase tracking-widest mb-2`}>
                Saved Indicators
              </div>

              {savedIndicators.length === 0 ? (
                <p className="text-[10px] text-zinc-600">No saved indicators yet. Build one in the Builder tab.</p>
              ) : (
                <div className="space-y-1.5">
                  {savedIndicators.map(ind => {
                    const isLoaded = libraryLoaded.some(l => l.id===ind.id);
                    return (
                      <div key={ind.id} className={[
                        "rounded border px-2 py-1.5",
                        isLoaded ? "border-blue-700 bg-blue-900/10" : "border-zinc-700 bg-zinc-800/40",
                      ].join(" ")}>
                        <div className="flex items-center gap-1.5 mb-1">
                          <span className={`text-[10px] ${ind.status==="complete" ? "text-zinc-200" : "text-zinc-500"}`}>
                            {ind.status==="complete" ? "●" : "○"}
                          </span>
                          <span className="text-[11px] text-zinc-200 flex-1 truncate" title={ind.name}>{ind.name}</span>
                        </div>
                        <div className="flex gap-1">
                          <button onClick={() => loadLibraryIndicator(ind)}
                            className={[
                              "flex-1 rounded border px-1.5 py-0.5 text-[10px] transition-colors",
                              isLoaded
                                ? "border-blue-700 text-blue-400 hover:bg-blue-900/30"
                                : "border-zinc-600 text-zinc-400 hover:bg-zinc-700/40",
                            ].join(" ")}>
                            {isLoaded ? "Unload" : "Load"}
                          </button>
                          <button
                            onClick={() => router.push(`/superchart?indicator_id=${ind.id}`)}
                            className="rounded border border-zinc-600 px-1.5 py-0.5 text-[10px] text-zinc-400 hover:bg-zinc-700/40 transition-colors"
                            title="Open in Superchart">
                            SC
                          </button>
                          <button
                            onClick={() => deleteSaved(ind.id)}
                            disabled={deletingId===ind.id}
                            className="rounded border border-red-800 p-0.5 text-red-400 hover:bg-red-900/30 disabled:opacity-30 transition-colors">
                            <svg className="h-3 w-3" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2">
                              <path d="M2 2l8 8M10 2l-8 8" />
                            </svg>
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {libraryLoaded.length > 0 && (
                <div className="mt-3 pt-2 border-t border-zinc-800">
                  <div className={`${lCls} mb-1`}>On chart (dotted)</div>
                  {libraryLoaded.map(l => (
                    <div key={l.id} className="flex items-center justify-between text-[10px] py-0.5">
                      <span className="text-blue-400 truncate">{l.name}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Chart column */}
        <div className="flex flex-col flex-1 overflow-hidden">
          <div ref={mainDivRef} className="flex-1" style={{minHeight:0}} />
          <div ref={subDivRef}  className="shrink-0" style={{height:150}} />

          {uniqueOscTypes.length > 0 && (
            <div className="flex items-center gap-1 px-2 py-1 border-t border-zinc-800 bg-zinc-900 shrink-0">
              <span className={`${lCls} mr-1`}>OSC</span>
              {uniqueOscTypes.map(tab => (
                <button key={tab} onClick={() => setActiveOsc(tab as OscTab)}
                  className={[
                    "text-[10px] px-2 py-0.5 rounded transition-colors",
                    activeOsc===tab ? "bg-blue-600 text-white" : "bg-zinc-800 text-zinc-400 hover:bg-zinc-700",
                  ].join(" ")}>
                  {tab}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
