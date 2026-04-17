"use client";

import { useEffect, useState } from "react";
import { fetchWithAuth } from "@/lib/auth";
import { DEFAULTS, loadSettings, saveSettings, type PlatformSettings } from "@/lib/settings";

// ---------------------------------------------------------------------------
// AI model catalogue
// ---------------------------------------------------------------------------
interface AIModel {
  id: string;
  provider: "Anthropic" | "OpenAI" | "Google";
  name: string;
  context: string;
  input_price: string;
  output_price: string;
  best_for: string;
  pros: string;
  cons: string;
  available: boolean;
}

const AI_MODELS: AIModel[] = [
  {
    id: "claude-opus-4-6",
    provider: "Anthropic",
    name: "Claude Opus 4.6",
    context: "200K",
    input_price: "$15.00",
    output_price: "$75.00",
    best_for: "Deep strategy diagnosis, complex analysis",
    pros: "Most capable reasoning, best at complex prompts",
    cons: "Slowest, most expensive",
    available: true,
  },
  {
    id: "claude-sonnet-4-6",
    provider: "Anthropic",
    name: "Claude Sonnet 4.6",
    context: "200K",
    input_price: "$3.00",
    output_price: "$15.00",
    best_for: "All-round use — recommended default",
    pros: "Great balance of quality and speed",
    cons: "—",
    available: true,
  },
  {
    id: "claude-haiku-4-5-20251001",
    provider: "Anthropic",
    name: "Claude Haiku 4.5",
    context: "200K",
    input_price: "$0.80",
    output_price: "$4.00",
    best_for: "Quick Co-Pilot responses, simple queries",
    pros: "Fastest, cheapest Claude model",
    cons: "Weaker on deep financial analysis",
    available: true,
  },
  {
    id: "gpt-4o",
    provider: "OpenAI",
    name: "GPT-4o",
    context: "128K",
    input_price: "$2.50",
    output_price: "$10.00",
    best_for: "Strong reasoning, widely trusted",
    pros: "Excellent JSON adherence, strong reasoning",
    cons: "Smaller context than Claude/Gemini",
    available: true,
  },
  {
    id: "gpt-4o-mini",
    provider: "OpenAI",
    name: "GPT-4o mini",
    context: "128K",
    input_price: "$0.15",
    output_price: "$0.60",
    best_for: "Very cheap and fast",
    pros: "Lowest cost OpenAI option",
    cons: "Weaker at complex financial reasoning",
    available: true,
  },
  {
    id: "gemini-2.5-pro",
    provider: "Google",
    name: "Gemini 2.5 Pro",
    context: "1M",
    input_price: "$1.25",
    output_price: "$10.00",
    best_for: "Long context, large trade datasets",
    pros: "Largest context window (1M tokens)",
    cons: "Slower response times",
    available: true,
  },
  {
    id: "gemini-2.0-flash",
    provider: "Google",
    name: "Gemini 2.0 Flash",
    context: "1M",
    input_price: "$0.10",
    output_price: "$0.40",
    best_for: "Lowest cost overall",
    pros: "Cheapest option by far",
    cons: "Weaker at structured financial analysis",
    available: true,
  },
];

const PROVIDER_COLORS: Record<AIModel["provider"], string> = {
  Anthropic: "bg-orange-900/40 text-orange-400 border border-orange-800/50",
  OpenAI:    "bg-emerald-900/40 text-emerald-400 border border-emerald-800/50",
  Google:    "bg-blue-900/40 text-blue-400 border border-blue-800/50",
};

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

interface ModelUsage {
  model: string;
  input_tokens: number;
  output_tokens: number;
  call_count: number;
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "K";
  return String(n);
}

export default function SettingsPage() {
  const [s, setS] = useState<PlatformSettings>(DEFAULTS);
  const [saved, setSaved] = useState(false);
  const [usage, setUsage] = useState<ModelUsage[]>([]);

  useEffect(() => {
    setS(loadSettings());
    fetchWithAuth("/api/settings/ai-usage")
      .then((r) => r.json())
      .then((d) => setUsage(d.usage ?? []))
      .catch(() => {});
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
    <div className="max-w-5xl space-y-8">
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

      {/* ── AI Model ── */}
      <div>
        <h2 className="text-xs font-semibold text-zinc-400 uppercase tracking-wide mb-3">
          AI Model
        </h2>
        <p className="text-xs text-zinc-500 mb-3">
          Choose which AI model powers the Co-Pilot, strategy diagnosis, and optimization.
          Prices are per 1M tokens.
        </p>
        <div className="overflow-x-auto rounded-lg border border-zinc-700">
          <table className="w-full text-xs text-zinc-300">
            <thead>
              <tr className="bg-zinc-800 border-b border-zinc-700 text-zinc-500 text-left">
                <th className="px-3 py-2.5 font-medium">Provider</th>
                <th className="px-3 py-2.5 font-medium">Model</th>
                <th className="px-3 py-2.5 font-medium">Context</th>
                <th className="px-3 py-2.5 font-medium whitespace-nowrap">Input / 1M</th>
                <th className="px-3 py-2.5 font-medium whitespace-nowrap">Output / 1M</th>
                <th className="px-3 py-2.5 font-medium">Best for</th>
                <th className="px-3 py-2.5 font-medium">Pros</th>
                <th className="px-3 py-2.5 font-medium">Cons</th>
                <th className="px-3 py-2.5 font-medium whitespace-nowrap">30-day tokens</th>
                <th className="px-3 py-2.5 font-medium"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-700/60">
              {AI_MODELS.map((m) => {
                const isActive = s.ai_model === m.id;
                return (
                  <tr
                    key={m.id}
                    className={`${isActive ? "bg-blue-900/10" : "bg-zinc-800/40"} hover:bg-zinc-700/30 transition-colors`}
                  >
                    <td className="px-3 py-2.5">
                      <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${PROVIDER_COLORS[m.provider]}`}>
                        {m.provider}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 font-medium text-zinc-100 whitespace-nowrap">{m.name}</td>
                    <td className="px-3 py-2.5 text-zinc-400 whitespace-nowrap">{m.context}</td>
                    <td className="px-3 py-2.5 text-zinc-300 whitespace-nowrap font-mono">{m.input_price}</td>
                    <td className="px-3 py-2.5 text-zinc-300 whitespace-nowrap font-mono">{m.output_price}</td>
                    <td className="px-3 py-2.5 text-zinc-400 min-w-[160px]">{m.best_for}</td>
                    <td className="px-3 py-2.5 text-emerald-400/80 min-w-[160px]">{m.pros}</td>
                    <td className="px-3 py-2.5 text-red-400/70 min-w-[160px]">{m.cons}</td>
                    <td className="px-3 py-2.5 whitespace-nowrap font-mono text-[11px]">
                      {(() => {
                        const u = usage.find((x) => x.model === m.id);
                        if (!u) return <span className="text-zinc-600">—</span>;
                        return (
                          <div className="space-y-0.5">
                            <div className="text-zinc-300">↑ {fmtTokens(u.input_tokens)}</div>
                            <div className="text-zinc-500">↓ {fmtTokens(u.output_tokens)}</div>
                            <div className="text-zinc-600 text-[10px]">{u.call_count} calls</div>
                          </div>
                        );
                      })()}
                    </td>
                    <td className="px-3 py-2.5 whitespace-nowrap">
                      {isActive ? (
                        <span className="inline-flex items-center gap-1 px-2 py-1 rounded bg-blue-900/40 border border-blue-700 text-blue-400 text-[10px] font-semibold">
                          ✓ Active
                        </span>
                      ) : (
                        <button
                          disabled={!m.available}
                          onClick={() => { set("ai_model", m.id); saveSettings({ ...s, ai_model: m.id }); }}
                          title={!m.available ? "Requires additional API key setup" : `Activate ${m.name}`}
                          className="px-2 py-1 rounded border border-zinc-600 text-zinc-400 text-[10px] hover:border-blue-600 hover:text-blue-400 hover:bg-blue-900/20 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                        >
                          Activate
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

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
