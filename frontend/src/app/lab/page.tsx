"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  createChart, CrosshairMode, IChartApi, ISeriesApi,
  LineStyle, LineWidth, Time,
} from "lightweight-charts";
import { fetchWithAuth } from "@/lib/auth";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
type IndType = "EMA" | "SMA" | "BB" | "RSI" | "MACD" | "ADX" | "STOCH" | "ATR";
type OscTab  = "RSI" | "MACD" | "ADX" | "STOCH" | "ATR";

interface LabIndicator {
  id: string;
  type: IndType;
  color: string;
  period: number;
  fast: number; slow: number; signal_period: number;
  std_dev: number;
  k_smooth: number; d_period: number;
}

interface LabCondition {
  id: string;
  indicator: string;
  operator: string;
  period: number;
  value: number;
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

const CHART_THEME = {
  bg: "#09090b", text: "#a1a1aa", grid: "#1c1c1f",
  border: "#27272a", up: "#22c55e", down: "#ef4444",
};

const DEFAULTS: Record<IndType, Partial<LabIndicator>> = {
  EMA:   { period: 20 },
  SMA:   { period: 50 },
  BB:    { period: 20, std_dev: 2.0 },
  RSI:   { period: 14 },
  MACD:  { fast: 12, slow: 26, signal_period: 9, period: 12 },
  ADX:   { period: 14 },
  STOCH: { period: 14, k_smooth: 3, d_period: 3 },
  ATR:   { period: 14 },
};

const OPERATORS = [">","<","price_above","price_below","crossed_above","crossed_below"];

let _uid = 0;
const uid = () => `i${++_uid}`;

function defaultFrom() {
  const d = new Date(); d.setFullYear(d.getFullYear() - 1);
  return d.toISOString().slice(0,10);
}
function defaultTo() { return new Date().toISOString().slice(0,10); }

function makeChart(el: HTMLDivElement, h: number, hideTime = false): IChartApi {
  return createChart(el, {
    width: el.clientWidth, height: h,
    layout: { background: { color: CHART_THEME.bg }, textColor: CHART_THEME.text },
    grid: { vertLines: { color: CHART_THEME.grid }, horzLines: { color: CHART_THEME.grid } },
    crosshair: { mode: CrosshairMode.Normal },
    rightPriceScale: { borderColor: CHART_THEME.border },
    timeScale: { borderColor: CHART_THEME.border, timeVisible: true, secondsVisible: false, visible: !hideTime },
  });
}

// ---------------------------------------------------------------------------
// Page wrapper
// ---------------------------------------------------------------------------
export default function LabPage() {
  return <Suspense><LabInner /></Suspense>;
}

function LabInner() {
  const searchParams = useSearchParams();

  // Controls
  const [pair,      setPair]      = useState("EURUSD");
  const [timeframe, setTimeframe] = useState("1H");
  const [dateFrom,  setDateFrom]  = useState(defaultFrom);
  const [dateTo,    setDateTo]    = useState(defaultTo);

  // Data
  const [candles,       setCandles]       = useState<Candle[]>([]);
  const [loadingCandles,setLoadingCandles] = useState(false);
  const [indicatorData, setIndicatorData] = useState<IndicatorGroup[]>([]);
  const [signals,       setSignals]       = useState<number[]>([]);
  const [computing,     setComputing]     = useState(false);

  // Builder
  const [indicators, setIndicators] = useState<LabIndicator[]>([]);
  const [conditions, setConditions] = useState<LabCondition[]>([]);
  const [newIndType, setNewIndType] = useState<IndType>("EMA");
  const [newCondInd, setNewCondInd] = useState("RSI");
  const [newCondOp,  setNewCondOp]  = useState(">");
  const [newCondPer, setNewCondPer] = useState(14);
  const [newCondVal, setNewCondVal] = useState(70);
  const [activeOsc,  setActiveOsc]  = useState<OscTab>("RSI");

  // Chart refs
  const mainDivRef   = useRef<HTMLDivElement>(null);
  const subDivRef    = useRef<HTMLDivElement>(null);
  const mainChart    = useRef<IChartApi|null>(null);
  const subChart     = useRef<IChartApi|null>(null);
  const candleSeries = useRef<ISeriesApi<"Candlestick">|null>(null);
  const overlayRefs  = useRef<ISeriesApi<"Line">[]>([]);
  const subRefs      = useRef<ISeriesApi<"Line"|"Histogram">[]>([]);
  const syncingRef   = useRef(false);
  const recomputeTimer = useRef<ReturnType<typeof setTimeout>|null>(null);

  // ---------------------------------------------------------------------------
  // Init charts (once)
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (!mainDivRef.current || !subDivRef.current) return;
    const main = makeChart(mainDivRef.current, mainDivRef.current.clientHeight);
    const sub  = makeChart(subDivRef.current,  subDivRef.current.clientHeight, false);
    const cs   = main.addCandlestickSeries({
      upColor: CHART_THEME.up, downColor: CHART_THEME.down,
      borderUpColor: CHART_THEME.up, borderDownColor: CHART_THEME.down,
      wickUpColor: CHART_THEME.up, wickDownColor: CHART_THEME.down,
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
  // Load candles
  // ---------------------------------------------------------------------------
  const loadCandles = useCallback(async (p: string, tf: string, from: string, to: string) => {
    setLoadingCandles(true);
    try {
      const res = await fetchWithAuth(
        `${API_BASE}/api/candles?pair=${p}&timeframe=${tf}&start=${from}&end=${to}&limit=5000`
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setCandles(data.candles ?? []);
    } catch { setCandles([]); }
    finally { setLoadingCandles(false); }
  }, []);

  useEffect(() => {
    if (dateFrom && dateTo) loadCandles(pair, timeframe, dateFrom, dateTo);
  }, [pair, timeframe, dateFrom, dateTo, loadCandles]);

  // ---------------------------------------------------------------------------
  // Render candles on chart
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (!candleSeries.current || candles.length === 0) return;
    candleSeries.current.setData(
      candles.map(c => ({ time: c.time as Time, open: c.open, high: c.high, low: c.low, close: c.close }))
    );
    mainChart.current?.timeScale().fitContent();
  }, [candles]);

  // ---------------------------------------------------------------------------
  // Compute indicators (debounced 300ms after any builder change)
  // ---------------------------------------------------------------------------
  const recompute = useCallback(async (inds: LabIndicator[], conds: LabCondition[], p: string, tf: string, from: string, to: string) => {
    if (inds.length === 0) {
      setIndicatorData([]); setSignals([]); return;
    }
    setComputing(true);
    try {
      const payload = {
        pair: p, timeframe: tf, from: from, to: to,
        indicators: inds.map(i => ({
          type: i.type,
          color: i.color,
          params: { period: i.period, fast: i.fast, slow: i.slow, signal_period: i.signal_period,
                    std_dev: i.std_dev, k_smooth: i.k_smooth, d_period: i.d_period },
        })),
      };
      const res = await fetchWithAuth(`${API_BASE}/api/lab/indicators`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (res.ok) {
        const data = await res.json();
        setIndicatorData(data.indicators ?? []);
      }

      if (conds.length > 0) {
        const sigPayload = {
          pair: p, timeframe: tf, from: from, to: to,
          indicators: payload.indicators,
          conditions: conds.map(c => ({
            indicator: c.indicator, operator: c.operator,
            period: c.period, value: c.value,
          })),
        };
        const sigRes = await fetchWithAuth(`${API_BASE}/api/lab/signals`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(sigPayload),
        });
        if (sigRes.ok) { const s = await sigRes.json(); setSignals(s.signals ?? []); }
      } else {
        setSignals([]);
      }
    } catch { /* non-fatal */ }
    finally { setComputing(false); }
  }, []);

  function scheduleRecompute(inds: LabIndicator[], conds: LabCondition[]) {
    if (recomputeTimer.current) clearTimeout(recomputeTimer.current);
    recomputeTimer.current = setTimeout(() => {
      recompute(inds, conds, pair, timeframe, dateFrom, dateTo);
    }, 300);
  }

  // Recompute when candles arrive
  useEffect(() => {
    if (candles.length > 0) recompute(indicators, conditions, pair, timeframe, dateFrom, dateTo);
  }, [candles]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------------------------------------------------------------------------
  // Render indicator series on charts
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
          const s = main.addLineSeries({ color: series.color, lineWidth: 1 as LineWidth,
            lineStyle: group.type === "SMA" ? LineStyle.Dashed : LineStyle.Solid,
            priceLineVisible: false, lastValueVisible: false, title: series.name });
          s.setData(series.data as { time: Time; value: number }[]);
          overlayRefs.current.push(s);
        }
      } else if (group.type === activeOsc) {
        // Levels
        group.levels?.forEach(lvl => {
          if (subRefs.current.length > 0) {
            subRefs.current[0].createPriceLine({ price: lvl.value, color: lvl.color,
              lineWidth: 1 as LineWidth, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: String(lvl.value) });
          }
        });
        for (const series of group.series) {
          if (series.style === "histogram") {
            const s = sub.addHistogramSeries({ priceLineVisible: false, title: series.name });
            s.setData(series.data as { time: Time; value: number; color?: string }[]);
            subRefs.current.push(s);
          } else {
            const s = sub.addLineSeries({ color: series.color, lineWidth: 1 as LineWidth,
              priceLineVisible: false, lastValueVisible: false, title: series.name });
            s.setData(series.data as { time: Time; value: number }[]);
            // levels applied to first series
            if (subRefs.current.length === 0) {
              group.levels?.forEach(lvl => {
                s.createPriceLine({ price: lvl.value, color: lvl.color,
                  lineWidth: 1 as LineWidth, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: String(lvl.value) });
              });
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
  // Render signal markers
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (!candleSeries.current) return;
    candleSeries.current.setMarkers(
      signals.map(ts => ({
        time: ts as Time,
        position: "belowBar" as const,
        color: "#22c55e",
        shape: "arrowUp" as const,
        text: "▲",
      })).sort((a, b) => (a.time as number) - (b.time as number))
    );
  }, [signals]);

  // ---------------------------------------------------------------------------
  // Builder helpers
  // ---------------------------------------------------------------------------
  function addIndicator() {
    const color = COLORS[indicators.length % COLORS.length];
    const ind: LabIndicator = {
      id: uid(), type: newIndType, color,
      period: 14, fast: 12, slow: 26, signal_period: 9, std_dev: 2.0, k_smooth: 3, d_period: 3,
      ...DEFAULTS[newIndType],
    };
    const next = [...indicators, ind];
    setIndicators(next);
    scheduleRecompute(next, conditions);
  }

  function updateIndicator(id: string, patch: Partial<LabIndicator>) {
    const next = indicators.map(i => i.id === id ? { ...i, ...patch } : i);
    setIndicators(next);
    scheduleRecompute(next, conditions);
  }

  function removeIndicator(id: string) {
    const next = indicators.filter(i => i.id !== id);
    setIndicators(next);
    scheduleRecompute(next, conditions);
  }

  function addCondition() {
    const next = [...conditions, { id: uid(), indicator: newCondInd, operator: newCondOp, period: newCondPer, value: newCondVal }];
    setConditions(next);
    scheduleRecompute(indicators, next);
  }

  function removeCondition(id: string) {
    const next = conditions.filter(c => c.id !== id);
    setConditions(next);
    scheduleRecompute(indicators, next);
  }

  // Oscillator types present in current indicator list
  const activeOscTypes = indicators.filter(i => OSC_TYPES.has(i.type)).map(i => i.type) as OscTab[];
  const uniqueOscTypes = [...new Set(activeOscTypes)];

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------
  const iCls = "bg-zinc-800 border border-zinc-700 rounded px-1 py-0.5 text-[11px] text-zinc-200 text-right no-spinner";
  const sCls = "bg-zinc-800 border border-zinc-700 rounded px-1 py-0.5 text-[11px] text-zinc-200";
  const lCls = "text-[10px] text-zinc-500";

  return (
    <div className="flex flex-col h-full overflow-hidden -m-1 bg-[#09090b] text-zinc-200">

      {/* ── Toolbar ──────────────────────────────────────────────────── */}
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-zinc-800 shrink-0 flex-wrap">
        <span className="text-[11px] font-semibold text-zinc-400 uppercase tracking-wider mr-1">Indicator Lab</span>
        <select value={pair} onChange={e => { setPair(e.target.value); }}
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
      </div>

      {/* ── Main area ────────────────────────────────────────────────── */}
      <div className="flex flex-1 overflow-hidden">

        {/* ── Builder panel ──────────────────────────────────────────── */}
        <div className="w-52 shrink-0 border-r border-zinc-800 flex flex-col overflow-y-auto">

          {/* Indicators section */}
          <div className="border-b border-zinc-800 px-3 py-2">
            <div className="text-[10px] font-semibold uppercase tracking-widest text-zinc-500 mb-2">Indicators</div>

            {/* Add row */}
            <div className="flex gap-1 mb-2">
              <select value={newIndType} onChange={e => setNewIndType(e.target.value as IndType)}
                className={`${sCls} flex-1`}>
                {ALL_TYPES.map(t => <option key={t}>{t}</option>)}
              </select>
              <button onClick={addIndicator} disabled={candles.length === 0}
                className="rounded border border-blue-700 px-2 py-0.5 text-[10px] text-blue-400 hover:bg-blue-900/30 disabled:opacity-30 disabled:cursor-not-allowed transition-colors">
                + Add
              </button>
            </div>

            {/* Indicator list */}
            {indicators.length === 0 ? (
              <p className="text-[10px] text-zinc-600">No indicators. Load candles then add.</p>
            ) : (
              <div className="space-y-2">
                {indicators.map(ind => (
                  <div key={ind.id} className="rounded border border-zinc-700 bg-zinc-800/60 px-2 py-1.5 space-y-1">
                    <div className="flex items-center gap-1.5">
                      <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: ind.color }} />
                      <span className="text-[11px] font-semibold text-zinc-200 flex-1">{ind.type}</span>
                      <button onClick={() => removeIndicator(ind.id)}
                        className="text-zinc-500 hover:text-red-400 text-sm leading-none transition-colors">×</button>
                    </div>

                    {/* Params */}
                    {ind.type === "MACD" ? (
                      <div className="grid grid-cols-3 gap-1">
                        {(["fast","slow","signal_period"] as const).map(k => (
                          <div key={k}>
                            <div className={lCls}>{k === "signal_period" ? "sig" : k}</div>
                            <input type="number" min={1} value={ind[k]}
                              onChange={e => updateIndicator(ind.id, { [k]: Math.max(1, parseInt(e.target.value)||1) })}
                              className={`${iCls} w-full`} />
                          </div>
                        ))}
                      </div>
                    ) : ind.type === "STOCH" ? (
                      <div className="grid grid-cols-3 gap-1">
                        {(["period","k_smooth","d_period"] as const).map(k => (
                          <div key={k}>
                            <div className={lCls}>{k === "k_smooth" ? "K sm" : k === "d_period" ? "D per" : "period"}</div>
                            <input type="number" min={1} value={ind[k]}
                              onChange={e => updateIndicator(ind.id, { [k]: Math.max(1, parseInt(e.target.value)||1) })}
                              className={`${iCls} w-full`} />
                          </div>
                        ))}
                      </div>
                    ) : ind.type === "BB" ? (
                      <div className="flex gap-2">
                        <div className="flex-1">
                          <div className={lCls}>period</div>
                          <input type="number" min={2} value={ind.period}
                            onChange={e => updateIndicator(ind.id, { period: Math.max(2, parseInt(e.target.value)||2) })}
                            className={`${iCls} w-full`} />
                        </div>
                        <div className="flex-1">
                          <div className={lCls}>σ</div>
                          <input type="number" min={0.1} step={0.1} value={ind.std_dev}
                            onChange={e => updateIndicator(ind.id, { std_dev: Math.max(0.1, parseFloat(e.target.value)||2) })}
                            className={`${iCls} w-full`} />
                        </div>
                      </div>
                    ) : (
                      <div>
                        <div className={lCls}>period</div>
                        <input type="number" min={1} value={ind.period}
                          onChange={e => updateIndicator(ind.id, { period: Math.max(1, parseInt(e.target.value)||1) })}
                          className={`${iCls} w-24`} />
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Signal Conditions section */}
          <div className="border-b border-zinc-800 px-3 py-2">
            <div className="text-[10px] font-semibold uppercase tracking-widest text-zinc-500 mb-2">
              Signal Conditions
              {signals.length > 0 && (
                <span className="ml-1.5 text-green-500 normal-case font-normal">{signals.length} signals</span>
              )}
            </div>

            {/* Condition builder row */}
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
                <label className={`${lCls} shrink-0`}>period</label>
                <input type="number" min={1} value={newCondPer} onChange={e => setNewCondPer(Math.max(1, parseInt(e.target.value)||1))}
                  className={`${iCls} w-14`} />
                {[">" ,"<"].includes(newCondOp) && <>
                  <label className={`${lCls} shrink-0`}>val</label>
                  <input type="number" value={newCondVal} onChange={e => setNewCondVal(parseFloat(e.target.value)||0)}
                    className={`${iCls} w-14`} />
                </>}
              </div>
              <button onClick={addCondition}
                className="w-full rounded border border-zinc-600 px-1.5 py-0.5 text-[10px] text-zinc-400 hover:bg-zinc-700/40 transition-colors">
                + Add Condition
              </button>
            </div>

            {/* Condition list */}
            {conditions.map(c => (
              <div key={c.id} className="flex items-center justify-between text-[10px] py-0.5">
                <span className="text-zinc-300">
                  {c.indicator}({c.period}) {c.operator} {[">" ,"<"].includes(c.operator) ? c.value : ""}
                </span>
                <button onClick={() => removeCondition(c.id)} className="text-zinc-600 hover:text-red-400 transition-colors ml-1">×</button>
              </div>
            ))}
          </div>

          {/* Save placeholder */}
          <div className="px-3 py-2">
            <div className="text-[10px] font-semibold uppercase tracking-widest text-zinc-500 mb-2">Save</div>
            <p className="text-[10px] text-zinc-600">Save & Export available in Lab PR 3</p>
          </div>
        </div>

        {/* ── Chart column ───────────────────────────────────────────── */}
        <div className="flex flex-col flex-1 overflow-hidden">
          {/* Main candlestick chart */}
          <div ref={mainDivRef} className="flex-1" style={{ minHeight: 0 }} />

          {/* Sub oscillator chart */}
          <div ref={subDivRef} className="shrink-0" style={{ height: 150 }} />

          {/* OSC tab bar */}
          {uniqueOscTypes.length > 0 && (
            <div className="flex items-center gap-1 px-2 py-1 border-t border-zinc-800 bg-zinc-900 shrink-0">
              <span className={`${lCls} mr-1`}>OSC</span>
              {uniqueOscTypes.map(tab => (
                <button key={tab} onClick={() => setActiveOsc(tab as OscTab)}
                  className={[
                    "text-[10px] px-2 py-0.5 rounded transition-colors",
                    activeOsc === tab ? "bg-blue-600 text-white" : "bg-zinc-800 text-zinc-400 hover:bg-zinc-700",
                  ].join(" ")}>
                  {tab}
                </button>
              ))}
            </div>
          )}

          {candles.length === 0 && !loadingCandles && (
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <p className="text-[11px] text-zinc-600">Select a pair, timeframe and date range to load candles</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
