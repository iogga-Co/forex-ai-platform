"use client";

import { useEffect, useState } from "react";
import { DEFAULTS, loadSettings, saveSettings, type PlatformSettings } from "@/lib/settings";

const PAIRS = ["EURUSD", "GBPUSD", "USDJPY", "EURGBP", "GBPJPY", "USDCHF"];
const TIMEFRAMES = ["1m", "1H"];

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h2 className="text-xs font-semibold text-zinc-400 uppercase tracking-wide mb-3">
        {title}
      </h2>
      <div className="bg-zinc-800 border border-zinc-700 rounded-lg divide-y divide-zinc-700">
        {children}
      </div>
    </div>
  );
}

function Row({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-6 px-4 py-3">
      <div className="min-w-0">
        <p className="text-sm text-zinc-100">{label}</p>
        {hint && <p className="text-xs text-zinc-500 mt-0.5">{hint}</p>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

export default function SettingsPage() {
  const [s, setS] = useState<PlatformSettings>(DEFAULTS);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setS(loadSettings());
  }, []);

  function set<K extends keyof PlatformSettings>(key: K, value: PlatformSettings[K]) {
    setS((prev) => ({ ...prev, [key]: value }));
    setSaved(false);
  }

  function handleSave() {
    saveSettings(s);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  function handleReset() {
    setS(DEFAULTS);
    saveSettings(DEFAULTS);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  const inputCls =
    "bg-zinc-900 border border-zinc-600 rounded px-2 py-1 text-sm text-zinc-100 w-28 text-right focus:outline-none focus:border-blue-500";
  const selectCls =
    "bg-zinc-900 border border-zinc-600 rounded px-2 py-1 text-sm text-zinc-100 focus:outline-none focus:border-blue-500";

  return (
    <div className="max-w-xl space-y-8">
      <div>
        <h1 className="text-xl font-semibold text-zinc-100">Settings</h1>
        <p className="text-sm text-zinc-500 mt-1">
          Preferences are saved in your browser and applied across the platform.
        </p>
      </div>

      {/* ── Backtest ── */}
      <Section title="Backtest">
        <Row
          label="History table rows"
          hint="How many past runs appear in the history list."
        >
          <input
            type="number"
            min={1}
            max={100}
            value={s.backtest_history_limit}
            onChange={(e) => set("backtest_history_limit", Math.max(1, Math.min(100, Number(e.target.value))))}
            className={inputCls}
          />
        </Row>
        <Row
          label="Default initial capital ($)"
          hint="Pre-filled capital amount for new backtest runs."
        >
          <input
            type="number"
            min={1000}
            step={1000}
            value={s.default_initial_capital}
            onChange={(e) => set("default_initial_capital", Number(e.target.value))}
            className={inputCls}
          />
        </Row>
        <Row label="Default start date" hint="Pre-filled period start for new runs.">
          <input
            type="date"
            value={s.default_period_start}
            onChange={(e) => set("default_period_start", e.target.value)}
            className={inputCls + " w-36"}
          />
        </Row>
        <Row label="Default end date" hint="Pre-filled period end for new runs.">
          <input
            type="date"
            value={s.default_period_end}
            onChange={(e) => set("default_period_end", e.target.value)}
            className={inputCls + " w-36"}
          />
        </Row>
      </Section>

      {/* ── Optimization ── */}
      <Section title="Optimization">
        <Row
          label="Default max iterations"
          hint="Pre-filled iteration limit for new optimization runs."
        >
          <input
            type="number"
            min={1}
            max={100}
            value={s.default_max_iterations}
            onChange={(e) => set("default_max_iterations", Math.max(1, Math.min(100, Number(e.target.value))))}
            className={inputCls}
          />
        </Row>
        <Row
          label="Default time limit (min)"
          hint="Pre-filled time limit for new optimization runs."
        >
          <input
            type="number"
            min={1}
            max={600}
            value={s.default_time_limit_minutes}
            onChange={(e) => set("default_time_limit_minutes", Math.max(1, Math.min(600, Number(e.target.value))))}
            className={inputCls}
          />
        </Row>
      </Section>

      {/* ── Display ── */}
      <Section title="Display defaults">
        <Row label="Default pair" hint="Pre-selected pair in all dropdowns.">
          <select
            value={s.default_pair}
            onChange={(e) => set("default_pair", e.target.value)}
            className={selectCls}
          >
            {PAIRS.map((p) => <option key={p}>{p}</option>)}
          </select>
        </Row>
        <Row label="Default timeframe" hint="Pre-selected timeframe in all dropdowns.">
          <select
            value={s.default_timeframe}
            onChange={(e) => set("default_timeframe", e.target.value)}
            className={selectCls}
          >
            {TIMEFRAMES.map((t) => <option key={t}>{t}</option>)}
          </select>
        </Row>
      </Section>

      {/* ── Actions ── */}
      <div className="flex items-center gap-3">
        <button
          onClick={handleSave}
          className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold rounded transition-colors"
        >
          {saved ? "Saved ✓" : "Save settings"}
        </button>
        <button
          onClick={handleReset}
          className="px-4 py-2 bg-zinc-700 hover:bg-zinc-600 text-zinc-200 text-sm rounded transition-colors"
        >
          Reset to defaults
        </button>
      </div>
    </div>
  );
}
