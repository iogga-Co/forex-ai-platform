"use client";

import { useState } from "react";

export interface NewsEvent {
  event_time: string;
  currency: string;
  title: string;
  impact: "high" | "medium" | "low";
  forecast: string | null;
  actual: string | null;
  previous: string | null;
  affected_pairs: string[];
  is_past: boolean;
  is_upcoming: boolean;
}

type SortKey = "event_time" | "currency" | "impact";
type SortDir = "asc" | "desc";

interface Props {
  events: NewsEvent[];
  loading: boolean;
}

const IMPACT_CONFIG = {
  high:   { dot: "🔴", label: "High",   cls: "bg-red-900/40 text-red-400 border border-red-800" },
  medium: { dot: "🟡", label: "Medium", cls: "bg-yellow-900/40 text-yellow-400 border border-yellow-800" },
  low:    { dot: "⚪", label: "Low",    cls: "bg-zinc-800 text-zinc-400 border border-zinc-700" },
};

function formatTime(iso: string): string {
  const d = new Date(iso);
  const opts: Intl.DateTimeFormatOptions = {
    month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit",
    hour12: false, timeZone: "UTC",
  };
  return d.toLocaleString("en-US", opts) + " UTC";
}

function compareActualForecast(actual: string | null, forecast: string | null): "beat" | "miss" | "neutral" {
  if (!actual || !forecast) return "neutral";
  const a = parseFloat(actual.replace(/[^0-9.-]/g, ""));
  const f = parseFloat(forecast.replace(/[^0-9.-]/g, ""));
  if (isNaN(a) || isNaN(f)) return "neutral";
  if (a > f) return "beat";
  if (a < f) return "miss";
  return "neutral";
}

export default function NewsCalendarTable({ events, loading }: Props) {
  const [sortKey, setSortKey] = useState<SortKey>("event_time");
  const [sortDir, setSortDir] = useState<SortDir>("asc");

  function handleSort(key: SortKey) {
    if (key === sortKey) {
      setSortDir(d => d === "asc" ? "desc" : "asc");
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
  }

  const sorted = [...events].sort((a, b) => {
    let cmp = 0;
    if (sortKey === "event_time") {
      cmp = a.event_time.localeCompare(b.event_time);
    } else if (sortKey === "currency") {
      cmp = a.currency.localeCompare(b.currency);
    } else if (sortKey === "impact") {
      const order = { high: 0, medium: 1, low: 2 };
      cmp = order[a.impact] - order[b.impact];
    }
    return sortDir === "asc" ? cmp : -cmp;
  });

  function SortHeader({ label, col }: { label: string; col: SortKey }) {
    const active = sortKey === col;
    return (
      <th
        className="px-3 py-2 text-left text-[10px] uppercase tracking-wide text-zinc-400 cursor-pointer select-none hover:text-zinc-200 whitespace-nowrap"
        onClick={() => handleSort(col)}
      >
        {label}
        {active && <span className="ml-1 text-zinc-500">{sortDir === "asc" ? "↑" : "↓"}</span>}
      </th>
    );
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16 text-zinc-500 text-sm">
        Loading calendar…
      </div>
    );
  }

  if (events.length === 0) {
    return (
      <div className="flex items-center justify-center py-16 text-zinc-500 text-sm">
        No events match the current filters.
      </div>
    );
  }

  return (
    <div className="overflow-x-auto rounded border border-zinc-800">
      <table className="w-full text-xs">
        <thead className="bg-zinc-900 border-b border-zinc-800">
          <tr>
            <SortHeader label="Date / Time (UTC)" col="event_time" />
            <SortHeader label="Currency" col="currency" />
            <th className="px-3 py-2 text-left text-[10px] uppercase tracking-wide text-zinc-400">Event</th>
            <SortHeader label="Impact" col="impact" />
            <th className="px-3 py-2 text-right text-[10px] uppercase tracking-wide text-zinc-400">Forecast</th>
            <th className="px-3 py-2 text-right text-[10px] uppercase tracking-wide text-zinc-400">Actual</th>
            <th className="px-3 py-2 text-right text-[10px] uppercase tracking-wide text-zinc-400">Previous</th>
            <th className="px-3 py-2 text-left text-[10px] uppercase tracking-wide text-zinc-400">Pairs</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((ev, i) => {
            const cfg = IMPACT_CONFIG[ev.impact];
            const outcome = compareActualForecast(ev.actual, ev.forecast);
            const actualCls = outcome === "beat"
              ? "text-green-400"
              : outcome === "miss"
              ? "text-red-400"
              : "text-zinc-300";

            const rowCls = ev.is_upcoming
              ? "bg-yellow-900/10 border-l-2 border-yellow-600"
              : ev.is_past
              ? "opacity-50"
              : "";

            return (
              <tr
                key={i}
                className={`border-b border-zinc-800/60 hover:bg-zinc-800/30 transition-colors ${rowCls}`}
              >
                <td className="px-3 py-2 text-zinc-300 whitespace-nowrap font-mono text-[11px]">
                  {formatTime(ev.event_time)}
                </td>
                <td className="px-3 py-2 font-semibold text-zinc-200">
                  {ev.currency}
                </td>
                <td className="px-3 py-2 text-zinc-300 min-w-[180px]">
                  {ev.title}
                </td>
                <td className="px-3 py-2">
                  <span className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] ${cfg.cls}`}>
                    {cfg.dot} {cfg.label}
                  </span>
                </td>
                <td className="px-3 py-2 text-right text-zinc-400">
                  {ev.forecast ?? "—"}
                </td>
                <td className={`px-3 py-2 text-right font-medium ${ev.actual ? actualCls : "text-zinc-500"}`}>
                  {ev.actual ?? "—"}
                </td>
                <td className="px-3 py-2 text-right text-zinc-400">
                  {ev.previous ?? "—"}
                </td>
                <td className="px-3 py-2">
                  <div className="flex flex-wrap gap-0.5">
                    {ev.affected_pairs.map(p => (
                      <span key={p} className="rounded bg-zinc-700 px-1 py-0.5 text-[9px] text-zinc-300">
                        {p}
                      </span>
                    ))}
                    {ev.affected_pairs.length === 0 && (
                      <span className="text-zinc-600">—</span>
                    )}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
