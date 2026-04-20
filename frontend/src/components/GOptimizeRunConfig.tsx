"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
import { fetchWithAuth } from "@/lib/auth";
import type { GOptimizeRun } from "@/lib/gOptimizeTypes";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const ALL_PAIRS = ["EURUSD", "GBPUSD", "USDJPY", "EURGBP", "GBPJPY", "USDCHF"];
const INDICATORS = ["RSI", "EMA", "SMA", "MACD", "BB", "ATR", "ADX", "STOCH"] as const;
const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
type ConditionSpec = {
  id: string;
  indicator: string;
  operator: string;
  period_min: number; period_max: number; period_step: number;
  value_min: number; value_max: number;
  fast_min: number; fast_max: number;
  slow_min: number; slow_max: number;
  signal_min: number; signal_max: number;
  std_dev_min: number; std_dev_max: number;
  bb_component: string;
  k_min: number; k_max: number;
  d_min: number; d_max: number;
  stoch_component: string;
  macd_component: string;
};

type StopSpec = {
  type: "atr" | "fixed_pips";
  period: number;
  multiplier_min: number; multiplier_max: number; multiplier_step: number;
  pips_min: number; pips_max: number;
};

type TrailingSpec = {
  enabled: boolean;
  type: "atr" | "fixed_pips";
  period: number;
  multiplier_min: number; multiplier_max: number;
  pips_min: number; pips_max: number;
  activation_min: number; activation_max: number;
};

type FormState = {
  entry_conditions: ConditionSpec[];
  max_entry_conditions: number;
  exit_mode: "first" | "all" | "stops_only";
  exit_conditions: ConditionSpec[];
  sl: StopSpec;
  tp: StopSpec;
  trailing: TrailingSpec;
  rr_floor: number;
  pairs: string[];
  timeframe: string;
  period_start: string;
  period_end: string;
  n_configs: number;
  store_trades: "passing" | "all" | "none";
  threshold_sharpe: number;
  threshold_win_rate: number;
  threshold_max_dd: number;
  threshold_min_trades: number;
  auto_rag: boolean;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
let _condId = 0;
function newId() { return `cond-${++_condId}-${Math.random().toString(36).slice(2, 5)}`; }

function opsFor(indicator: string): string[] {
  if (indicator === "BB") return ["price_above", "price_below"];
  if (indicator === "EMA" || indicator === "SMA")
    return ["price_above", "price_below", "crossed_above", "crossed_below"];
  if (indicator === "ATR") return [">", "<"];
  return [">", "<", "crossed_above", "crossed_below"];
}

function needsValue(op: string) {
  return [">", "<", "crossed_above", "crossed_below"].includes(op);
}

function defaultCond(indicator = "RSI"): ConditionSpec {
  const isPrice = ["EMA", "SMA", "BB"].includes(indicator);
  return {
    id: newId(),
    indicator,
    operator: isPrice ? "price_above" : indicator === "ATR" ? ">" : ">",
    period_min: indicator === "EMA" || indicator === "SMA" ? 8 : 10,
    period_max: indicator === "EMA" || indicator === "SMA" ? 100 : 20,
    period_step: indicator === "EMA" || indicator === "SMA" ? 10 : 5,
    value_min: indicator === "RSI" ? 40 : indicator === "ADX" ? 20 : 0,
    value_max: indicator === "RSI" ? 70 : indicator === "ADX" ? 30 : 0.1,
    fast_min: 8, fast_max: 16,
    slow_min: 20, slow_max: 32,
    signal_min: 7, signal_max: 12,
    std_dev_min: 1.5, std_dev_max: 3.0,
    bb_component: "upper",
    k_min: 5, k_max: 14,
    d_min: 3, d_max: 5,
    stoch_component: "k",
    macd_component: "histogram",
  };
}

const DEFAULT_FORM: FormState = {
  entry_conditions: [defaultCond("RSI"), defaultCond("EMA")],
  max_entry_conditions: 3,
  exit_mode: "first",
  exit_conditions: [],
  sl: { type: "atr", period: 14, multiplier_min: 1.0, multiplier_max: 3.0, multiplier_step: 0.5, pips_min: 10, pips_max: 50 },
  tp: { type: "atr", period: 14, multiplier_min: 1.5, multiplier_max: 5.0, multiplier_step: 0.5, pips_min: 20, pips_max: 100 },
  trailing: { enabled: false, type: "atr", period: 14, multiplier_min: 1.0, multiplier_max: 2.0, pips_min: 10, pips_max: 30, activation_min: 1.0, activation_max: 2.0 },
  rr_floor: 1.5,
  pairs: [...ALL_PAIRS],
  timeframe: "1H",
  period_start: "2022-01-01",
  period_end: "2025-01-01",
  n_configs: 5000,
  store_trades: "passing",
  threshold_sharpe: 0.8,
  threshold_win_rate: 45,
  threshold_max_dd: 15,
  threshold_min_trades: 30,
  auto_rag: true,
};

function serializeCond(c: ConditionSpec): Record<string, unknown> {
  const out: Record<string, unknown> = { indicator: c.indicator, operator: c.operator };
  if (c.indicator === "MACD") {
    Object.assign(out, { fast_min: c.fast_min, fast_max: c.fast_max, slow_min: c.slow_min, slow_max: c.slow_max, signal_min: c.signal_min, signal_max: c.signal_max, component: c.macd_component });
  } else if (c.indicator === "STOCH") {
    Object.assign(out, { k_min: c.k_min, k_max: c.k_max, d_min: c.d_min, d_max: c.d_max, component: c.stoch_component });
  } else if (c.indicator === "BB") {
    Object.assign(out, { period_min: c.period_min, period_max: c.period_max, period_step: c.period_step, std_dev_min: c.std_dev_min, std_dev_max: c.std_dev_max, component: c.bb_component });
  } else {
    Object.assign(out, { period_min: c.period_min, period_max: c.period_max, period_step: c.period_step });
  }
  if (needsValue(c.operator)) {
    out.value_min = c.value_min;
    out.value_max = c.value_max;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------
const iCls = "bg-zinc-800 border border-zinc-600 rounded px-1 py-0.5 text-xs text-zinc-200 text-right no-spinner";
const sCls = "bg-zinc-800 border border-zinc-600 rounded px-1 py-0.5 text-xs text-zinc-200";
const lCls = "text-[10px] text-zinc-500";

function NumInput({ value, onChange, min, max, step, w = "w-12" }: {
  value: number; onChange: (v: number) => void;
  min?: number; max?: number; step?: number; w?: string;
}) {
  const [raw, setRaw] = useState(String(value));
  const prevProp = useRef(value);

  // Sync external changes (e.g. form reset) without clobbering mid-edit
  useEffect(() => {
    if (value !== prevProp.current) {
      prevProp.current = value;
      setRaw(String(value));
    }
  }, [value]);

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    setRaw(e.target.value);
    const n = parseFloat(e.target.value);
    if (!isNaN(n)) onChange(n);
  }

  function handleBlur() {
    const n = parseFloat(raw);
    const clamped = isNaN(n) ? (min ?? 0) : (min !== undefined ? Math.max(min, n) : n);
    const final = max !== undefined ? Math.min(max, clamped) : clamped;
    prevProp.current = final;
    setRaw(String(final));
    onChange(final);
  }

  return (
    <input
      type="number" className={`${iCls} ${w}`}
      value={raw} min={min} max={max} step={step ?? 1}
      onChange={handleChange}
      onBlur={handleBlur}
      onFocus={(e) => e.target.select()}
    />
  );
}

function Range({ label, vMin, vMax, onMin, onMax, step, w }: {
  label: string; vMin: number; vMax: number;
  onMin: (v: number) => void; onMax: (v: number) => void;
  step?: number; w?: string;
}) {
  return (
    <label className="flex items-center gap-0.5">
      <span className={lCls}>{label}</span>
      <NumInput value={vMin} onChange={onMin} step={step} w={w} />
      <span className={lCls}>─</span>
      <NumInput value={vMax} onChange={onMax} step={step} w={w} />
    </label>
  );
}

function ConditionRow({ cond, onUpdate, onRemove, isExit = false }: {
  cond: ConditionSpec;
  onUpdate: (updates: Partial<ConditionSpec>) => void;
  onRemove: () => void;
  isExit?: boolean;
}) {
  const ops = opsFor(cond.indicator);
  const hasVal = needsValue(cond.operator);

  function changeIndicator(ind: string) {
    const newOps = opsFor(ind);
    const op = newOps.includes(cond.operator) ? cond.operator : newOps[0];
    onUpdate({ ...defaultCond(ind), id: cond.id, indicator: ind, operator: op });
  }

  return (
    <div className="flex items-center gap-1 flex-wrap border border-zinc-700/60 rounded px-2 py-1.5 bg-zinc-800/40">
      {/* Indicator */}
      <select className={`${sCls} w-16`} value={cond.indicator} onChange={(e) => changeIndicator(e.target.value)}>
        {INDICATORS.map((i) => <option key={i}>{i}</option>)}
      </select>

      {/* Params by indicator type */}
      {cond.indicator === "MACD" ? (
        <>
          <Range label="fast" vMin={cond.fast_min} vMax={cond.fast_max} onMin={(v) => onUpdate({ fast_min: v })} onMax={(v) => onUpdate({ fast_max: v })} />
          <Range label="slow" vMin={cond.slow_min} vMax={cond.slow_max} onMin={(v) => onUpdate({ slow_min: v })} onMax={(v) => onUpdate({ slow_max: v })} />
          <Range label="sig" vMin={cond.signal_min} vMax={cond.signal_max} onMin={(v) => onUpdate({ signal_min: v })} onMax={(v) => onUpdate({ signal_max: v })} />
          <label className="flex items-center gap-0.5">
            <span className={lCls}>comp</span>
            <select className={`${sCls} w-20`} value={cond.macd_component} onChange={(e) => onUpdate({ macd_component: e.target.value })}>
              {["line", "signal", "histogram"].map((c) => <option key={c}>{c}</option>)}
            </select>
          </label>
        </>
      ) : cond.indicator === "STOCH" ? (
        <>
          <Range label="K" vMin={cond.k_min} vMax={cond.k_max} onMin={(v) => onUpdate({ k_min: v })} onMax={(v) => onUpdate({ k_max: v })} />
          <Range label="D" vMin={cond.d_min} vMax={cond.d_max} onMin={(v) => onUpdate({ d_min: v })} onMax={(v) => onUpdate({ d_max: v })} />
        </>
      ) : cond.indicator === "BB" ? (
        <>
          <Range label="period" vMin={cond.period_min} vMax={cond.period_max} onMin={(v) => onUpdate({ period_min: v })} onMax={(v) => onUpdate({ period_max: v })} />
          <Range label="σ" vMin={cond.std_dev_min} vMax={cond.std_dev_max} onMin={(v) => onUpdate({ std_dev_min: v })} onMax={(v) => onUpdate({ std_dev_max: v })} step={0.01} />
          <label className="flex items-center gap-0.5">
            <span className={lCls}>band</span>
            <select className={`${sCls} w-16`} value={cond.bb_component} onChange={(e) => onUpdate({ bb_component: e.target.value })}>
              {["upper", "middle", "lower"].map((c) => <option key={c}>{c}</option>)}
            </select>
          </label>
        </>
      ) : (
        <>
          <Range label="period" vMin={cond.period_min} vMax={cond.period_max} onMin={(v) => onUpdate({ period_min: v })} onMax={(v) => onUpdate({ period_max: v })} />
          <label className="flex items-center gap-0.5">
            <span className={lCls}>step</span>
            <NumInput value={cond.period_step} onChange={(v) => onUpdate({ period_step: v })} min={1} />
          </label>
        </>
      )}

      {/* Operator */}
      <select className={`${sCls} w-28`} value={cond.operator} onChange={(e) => onUpdate({ operator: e.target.value })}>
        {ops.map((o) => <option key={o}>{o}</option>)}
      </select>

      {/* Value range — only for threshold operators */}
      {hasVal && (
        <Range label="val" vMin={cond.value_min} vMax={cond.value_max}
          onMin={(v) => onUpdate({ value_min: v })} onMax={(v) => onUpdate({ value_max: v })}
          step={0.01} />
      )}

      {/* Remove */}
      <button
        type="button"
        onClick={onRemove}
        className="ml-auto rounded border border-red-800 p-0.5 text-red-400 hover:bg-red-900/30 transition-colors"
        title={`Remove ${isExit ? "exit" : "entry"} condition`}
      >
        <svg className="h-3 w-3" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M2 2l8 8M10 2l-8 8" />
        </svg>
      </button>
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[10px] font-semibold text-zinc-400 uppercase tracking-wide border-b border-zinc-700/60 pb-1 mb-2">
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------
interface Props {
  onCreated: (run: GOptimizeRun) => void;
  onCancel: () => void;
}

export default function GOptimizeRunConfig({ onCreated, onCancel }: Props) {
  const [form, setForm] = useState<FormState>({ ...DEFAULT_FORM, entry_conditions: DEFAULT_FORM.entry_conditions.map((c) => ({ ...c })) });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function set<K extends keyof FormState>(key: K, val: FormState[K]) {
    setForm((f) => ({ ...f, [key]: val }));
  }

  function updateEntry(id: string, updates: Partial<ConditionSpec>) {
    set("entry_conditions", form.entry_conditions.map((c) => c.id === id ? { ...c, ...updates } : c));
  }
  function removeEntry(id: string) {
    set("entry_conditions", form.entry_conditions.filter((c) => c.id !== id));
  }
  function addEntry() {
    if (form.entry_conditions.length >= 10) return;
    set("entry_conditions", [...form.entry_conditions, defaultCond("RSI")]);
  }

  function updateExit(id: string, updates: Partial<ConditionSpec>) {
    set("exit_conditions", form.exit_conditions.map((c) => c.id === id ? { ...c, ...updates } : c));
  }
  function removeExit(id: string) {
    set("exit_conditions", form.exit_conditions.filter((c) => c.id !== id));
  }
  function addExit() {
    if (form.exit_conditions.length >= 10) return;
    set("exit_conditions", [...form.exit_conditions, defaultCond("RSI")]);
  }

  function togglePair(pair: string) {
    const next = form.pairs.includes(pair)
      ? form.pairs.filter((p) => p !== pair)
      : [...form.pairs, pair];
    set("pairs", next);
  }

  const estHrs = Math.round((form.n_configs * form.pairs.length * 1.7) / 3600 * 10) / 10;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);

    if (form.pairs.length === 0) { setError("Select at least one pair."); return; }
    if (form.entry_conditions.length === 0) { setError("Add at least one entry condition."); return; }

    // R:R floor validation (ATR-based only)
    if (form.sl.type === "atr" && form.tp.type === "atr") {
      if (form.tp.multiplier_min < form.rr_floor * form.sl.multiplier_min) {
        setError(`TP min (${form.tp.multiplier_min}) must be ≥ R:R floor (${form.rr_floor}) × SL min (${form.sl.multiplier_min}).`);
        return;
      }
    }

    const entry_config = {
      max_conditions: form.max_entry_conditions,
      conditions: form.entry_conditions.map(serializeCond),
    };
    const exit_config = {
      exit_mode: form.exit_mode,
      indicator_exits: form.exit_conditions.map(serializeCond),
      sl: form.sl,
      tp: form.tp,
      trailing: form.trailing,
      rr_floor: form.rr_floor,
    };

    setSubmitting(true);
    try {
      const res = await fetchWithAuth(`${API_BASE}/api/g-optimize/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pairs: form.pairs,
          timeframe: form.timeframe,
          period_start: form.period_start,
          period_end: form.period_end,
          n_configs: form.n_configs,
          store_trades: form.store_trades,
          entry_config,
          exit_config,
          threshold_sharpe: form.threshold_sharpe,
          threshold_win_rate: form.threshold_win_rate,
          threshold_max_dd: form.threshold_max_dd,
          threshold_min_trades: form.threshold_min_trades,
          auto_rag: form.auto_rag,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error((err as { detail?: string }).detail ?? `HTTP ${res.status}`);
      }
      const run: GOptimizeRun = await res.json();
      onCreated(run);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------
  return (
    <div className="flex flex-col flex-1 overflow-hidden">
      {/* Scrollable form body */}
      <form onSubmit={handleSubmit} className="flex-1 overflow-y-auto px-4 py-3 space-y-4">

        {/* ── Entry Conditions ───────────────────────────────────────────── */}
        <div>
          <SectionTitle>Entry Conditions</SectionTitle>
          <div className="space-y-1.5">
            {form.entry_conditions.map((cond) => (
              <ConditionRow
                key={cond.id}
                cond={cond}
                onUpdate={(u) => updateEntry(cond.id, u)}
                onRemove={() => removeEntry(cond.id)}
              />
            ))}
          </div>
          <div className="flex items-center gap-3 mt-2">
            <button
              type="button"
              onClick={addEntry}
              disabled={form.entry_conditions.length >= 10}
              className="rounded border border-blue-700 px-1.5 py-0.5 text-[10px] text-blue-400 hover:bg-blue-900/30 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            >
              + Add Condition
            </button>
            <label className="flex items-center gap-1.5">
              <span className={lCls}>Max per strategy</span>
              <select
                className={`${sCls} w-10`}
                value={form.max_entry_conditions}
                onChange={(e) => set("max_entry_conditions", parseInt(e.target.value, 10))}
              >
                {[1,2,3,4,5,6,7,8,9,10].map((n) => <option key={n}>{n}</option>)}
              </select>
            </label>
          </div>
        </div>

        {/* ── Exit Conditions ────────────────────────────────────────────── */}
        <div>
          <SectionTitle>Exit Conditions</SectionTitle>

          {/* Exit mode */}
          <div className="flex items-center gap-3 mb-2">
            <span className={lCls}>Exit mode</span>
            {(["first", "all", "stops_only"] as const).map((mode) => (
              <label key={mode} className="flex items-center gap-1 cursor-pointer">
                <input
                  type="radio"
                  className="accent-blue-500"
                  name="exit_mode"
                  value={mode}
                  checked={form.exit_mode === mode}
                  onChange={() => set("exit_mode", mode)}
                />
                <span className="text-[10px] text-zinc-300">
                  {mode === "first" ? "First trigger" : mode === "all" ? "All required" : "SL/TP only"}
                </span>
              </label>
            ))}
          </div>

          {/* Indicator exits */}
          {form.exit_conditions.length > 0 && (
            <div className="space-y-1.5 mb-2">
              {form.exit_conditions.map((cond) => (
                <ConditionRow
                  key={cond.id}
                  cond={cond}
                  onUpdate={(u) => updateExit(cond.id, u)}
                  onRemove={() => removeExit(cond.id)}
                  isExit
                />
              ))}
            </div>
          )}
          {form.exit_mode !== "stops_only" && (
            <button
              type="button"
              onClick={addExit}
              disabled={form.exit_conditions.length >= 10}
              className="rounded border border-zinc-700 px-1.5 py-0.5 text-[10px] text-zinc-400 hover:bg-zinc-700/40 disabled:opacity-30 disabled:cursor-not-allowed transition-colors mb-3"
            >
              + Add Exit Indicator
            </button>
          )}

          {/* SL / TP */}
          {(["sl", "tp"] as const).map((side) => {
            const spec = form[side];
            const label = side === "sl" ? "Stop Loss" : "Take Profit";
            return (
              <div key={side} className="mb-2 border border-zinc-700/60 rounded p-2 bg-zinc-800/30">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-[10px] font-medium text-zinc-300 w-16">{label}</span>
                  {(["atr", "fixed_pips"] as const).map((t) => (
                    <label key={t} className="flex items-center gap-1 cursor-pointer">
                      <input type="radio" className="accent-blue-500" name={`${side}_type`}
                        checked={spec.type === t} onChange={() => set(side, { ...spec, type: t })} />
                      <span className="text-[10px] text-zinc-300">{t === "atr" ? "ATR" : "Fixed pips"}</span>
                    </label>
                  ))}
                </div>
                {spec.type === "atr" ? (
                  <div className="flex items-center gap-2 flex-wrap">
                    <label className="flex items-center gap-0.5">
                      <span className={lCls}>period</span>
                      <NumInput value={spec.period} onChange={(v) => set(side, { ...spec, period: Math.min(200, Math.max(1, Math.round(v))) })} min={1} max={200} step={1} />
                      <span className={lCls}>(1–200)</span>
                    </label>
                    <Range label="mult" vMin={spec.multiplier_min} vMax={spec.multiplier_max}
                      onMin={(v) => set(side, { ...spec, multiplier_min: v })}
                      onMax={(v) => set(side, { ...spec, multiplier_max: v })} step={0.01} />
                    <label className="flex items-center gap-0.5">
                      <span className={lCls}>step</span>
                      <NumInput value={spec.multiplier_step} onChange={(v) => set(side, { ...spec, multiplier_step: Math.max(0.01, v) })} step={0.01} min={0.01} />
                      <span className={lCls}>(min 0.01)</span>
                    </label>
                  </div>
                ) : (
                  <Range label="pips" vMin={spec.pips_min} vMax={spec.pips_max}
                    onMin={(v) => set(side, { ...spec, pips_min: v })}
                    onMax={(v) => set(side, { ...spec, pips_max: v })} />
                )}
              </div>
            );
          })}

          {/* Trailing stop */}
          <div className="border border-zinc-700/60 rounded p-2 bg-zinc-800/30 mb-2">
            <label className="flex items-center gap-1.5 cursor-pointer mb-1">
              <input type="checkbox" className="accent-blue-500"
                checked={form.trailing.enabled}
                onChange={(e) => set("trailing", { ...form.trailing, enabled: e.target.checked })} />
              <span className="text-[10px] font-medium text-zinc-300">Trailing Stop</span>
            </label>
            {form.trailing.enabled && (
              <div className="flex items-center gap-2 flex-wrap">
                {(["atr", "fixed_pips"] as const).map((t) => (
                  <label key={t} className="flex items-center gap-1 cursor-pointer">
                    <input type="radio" className="accent-blue-500" name="tsl_type"
                      checked={form.trailing.type === t}
                      onChange={() => set("trailing", { ...form.trailing, type: t })} />
                    <span className="text-[10px] text-zinc-300">{t === "atr" ? "ATR" : "Fixed pips"}</span>
                  </label>
                ))}
                {form.trailing.type === "atr" ? (
                  <>
                    <label className="flex items-center gap-0.5">
                      <span className={lCls}>period</span>
                      <NumInput value={form.trailing.period} onChange={(v) => set("trailing", { ...form.trailing, period: Math.max(1, Math.round(v)) })} min={1} step={1} />
                      <span className={lCls}>(min 1)</span>
                    </label>
                    <Range label="mult" vMin={form.trailing.multiplier_min} vMax={form.trailing.multiplier_max}
                      onMin={(v) => set("trailing", { ...form.trailing, multiplier_min: v })}
                      onMax={(v) => set("trailing", { ...form.trailing, multiplier_max: v })} step={0.01} />
                    <Range label="act×ATR" vMin={form.trailing.activation_min} vMax={form.trailing.activation_max}
                      onMin={(v) => set("trailing", { ...form.trailing, activation_min: v })}
                      onMax={(v) => set("trailing", { ...form.trailing, activation_max: v })} step={0.01} />
                  </>
                ) : (
                  <Range label="pips" vMin={form.trailing.pips_min} vMax={form.trailing.pips_max}
                    onMin={(v) => set("trailing", { ...form.trailing, pips_min: v })}
                    onMax={(v) => set("trailing", { ...form.trailing, pips_max: v })} />
                )}
              </div>
            )}
          </div>

          {/* R:R floor */}
          <label className="flex items-center gap-1.5">
            <span className={lCls}>R:R floor (TP ≥ N × SL)</span>
            <NumInput value={form.rr_floor} onChange={(v) => set("rr_floor", Math.max(0.1, v))} min={0.1} step={0.01} w="w-14" />
            <span className={lCls}>(min 0.1)</span>
          </label>
        </div>

        {/* ── Search Config ──────────────────────────────────────────────── */}
        <div>
          <SectionTitle>Search Config</SectionTitle>

          {/* Pairs */}
          <div className="mb-2">
            <div className={`${lCls} mb-1`}>Pairs</div>
            <div className="flex flex-wrap gap-x-3 gap-y-1">
              {ALL_PAIRS.map((pair) => (
                <label key={pair} className="flex items-center gap-1 cursor-pointer">
                  <input type="checkbox" className="accent-blue-500"
                    checked={form.pairs.includes(pair)}
                    onChange={() => togglePair(pair)} />
                  <span className="text-[10px] text-zinc-300">{pair}</span>
                </label>
              ))}
            </div>
            {form.pairs.length === 0 && (
              <p className="text-[10px] text-red-400 mt-1">Select at least one pair.</p>
            )}
          </div>

          {/* Timeframe + period */}
          <div className="flex items-center gap-3 flex-wrap mb-2">
            <label className="flex items-center gap-1.5">
              <span className={lCls}>Timeframe</span>
              <select
                className={`${sCls} w-16`}
                value={form.timeframe}
                onChange={(e) => set("timeframe", e.target.value)}
              >
                {["1m", "5m", "15m", "30m", "1H", "4H", "1D"].map((tf) => (
                  <option key={tf}>{tf}</option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-1.5">
              <span className={lCls}>Start</span>
              <input type="date" required className={`${sCls} w-32`}
                value={form.period_start}
                onChange={(e) => set("period_start", e.target.value)} />
            </label>
            <label className="flex items-center gap-1.5">
              <span className={lCls}>End</span>
              <input type="date" required className={`${sCls} w-32`}
                value={form.period_end}
                onChange={(e) => set("period_end", e.target.value)} />
            </label>
          </div>

          {/* N configs + store trades */}
          <div className="flex items-center gap-4 flex-wrap">
            <div className="flex flex-col gap-0.5">
              <label className="flex items-center gap-1.5">
                <span className={lCls}>Configs to sample</span>
                <NumInput value={form.n_configs} onChange={(v) => set("n_configs", Math.max(100, Math.round(v)))} min={100} step={1} w="w-20" />
                <span className={lCls}>min 100</span>
              </label>
              {form.n_configs < 100 && (
                <p className="text-[10px] text-red-400">Minimum 100 configs.</p>
              )}
            </div>
            <div className="flex items-center gap-2">
              <span className={lCls}>Store trades</span>
              {(["passing", "all", "none"] as const).map((t) => (
                <label key={t} className="flex items-center gap-1 cursor-pointer">
                  <input type="radio" className="accent-blue-500" name="store_trades"
                    value={t} checked={form.store_trades === t}
                    onChange={() => set("store_trades", t)} />
                  <span className="text-[10px] text-zinc-300 capitalize">{t}</span>
                </label>
              ))}
            </div>
          </div>
          {form.store_trades === "all" && (
            <p className="text-[10px] text-yellow-500 mt-1">
              ⚠ &quot;All&quot; stores ~3M rows per 5,000 configs — use sparingly.
            </p>
          )}
        </div>

        {/* ── Passing Threshold ─────────────────────────────────────────── */}
        <div>
          <SectionTitle>Passing Threshold</SectionTitle>
          <div className="flex items-center gap-3 flex-wrap mb-2">
            <label className="flex items-center gap-1">
              <span className={lCls}>Sharpe ≥</span>
              <NumInput value={form.threshold_sharpe} onChange={(v) => set("threshold_sharpe", v)} step={0.1} min={0} w="w-14" />
            </label>
            <label className="flex items-center gap-1">
              <span className={lCls}>Win Rate ≥</span>
              <NumInput value={form.threshold_win_rate} onChange={(v) => set("threshold_win_rate", v)} step={1} min={0} max={100} w="w-12" />
              <span className={lCls}>%</span>
            </label>
            <label className="flex items-center gap-1">
              <span className={lCls}>Max DD ≤</span>
              <NumInput value={form.threshold_max_dd} onChange={(v) => set("threshold_max_dd", v)} step={1} min={0} max={100} w="w-12" />
              <span className={lCls}>%</span>
            </label>
            <label className="flex items-center gap-1">
              <span className={lCls}>Min trades</span>
              <NumInput value={form.threshold_min_trades} onChange={(v) => set("threshold_min_trades", Math.max(1, Math.round(v)))} step={1} min={1} w="w-14" />
            </label>
          </div>
          <label className="flex items-center gap-1.5 cursor-pointer">
            <input type="checkbox" className="accent-blue-500"
              checked={form.auto_rag}
              onChange={(e) => set("auto_rag", e.target.checked)} />
            <span className="text-[10px] text-zinc-300">Auto-send passing strategies to RAG</span>
          </label>
          {!form.auto_rag && (
            <p className="text-[10px] text-zinc-500 mt-0.5 ml-4">
              Strategies will be held in Pending state — review and promote manually.
            </p>
          )}
        </div>

        {/* ── Submit ────────────────────────────────────────────────────── */}
        <div className="border-t border-zinc-700/60 pt-3 flex items-center gap-4">
          <button
            type="submit"
            disabled={submitting}
            className="rounded border border-blue-700 px-3 py-1 text-[11px] text-blue-400 hover:bg-blue-900/30 disabled:opacity-40 disabled:cursor-not-allowed transition-colors font-medium"
          >
            {submitting ? "Submitting…" : "▶ Start G-Optimize"}
          </button>
          <span className="text-[10px] text-zinc-500">
            Estimated: ~{estHrs} hrs
            <span className="ml-1 text-zinc-600">
              ({form.n_configs.toLocaleString()} configs × {form.pairs.length} pair{form.pairs.length !== 1 ? "s" : ""})
            </span>
          </span>
          <button
            type="button"
            onClick={onCancel}
            className="ml-auto text-[10px] text-zinc-500 hover:text-zinc-300 transition-colors"
          >
            Cancel
          </button>
        </div>

        {error && (
          <p className="text-[11px] text-red-400 border border-red-800 rounded px-2 py-1 bg-red-900/10">
            {error}
          </p>
        )}
      </form>
    </div>
  );
}
