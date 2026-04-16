"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import AuthGuard from "@/components/AuthGuard";
import NewsCalendarTable, { NewsEvent } from "@/components/NewsCalendarTable";
import UpcomingEventsBanner from "@/components/UpcomingEventsBanner";
import { fetchWithAuth } from "@/lib/auth";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ALL_CURRENCIES = ["USD", "EUR", "GBP", "JPY", "CHF"] as const;
type ImpactFilter = "all" | "high" | "medium" | "low";

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

function plusDaysStr(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Inner page (uses state/effects — wrapped in Suspense by default export)
// ---------------------------------------------------------------------------

function NewsPageInner() {
  const [from, setFrom] = useState(todayStr());
  const [to, setTo] = useState(plusDaysStr(7));
  const [currencies, setCurrencies] = useState<string[]>([...ALL_CURRENCIES]);
  const [impact, setImpact] = useState<ImpactFilter>("all");

  const [events, setEvents] = useState<NewsEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [stale, setStale] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadEvents = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({
        from,
        to,
        currencies: currencies.join(","),
        impact,
      });
      const data = await fetchWithAuth(`/api/news/calendar?${params.toString()}`);
      setEvents(data.events ?? []);
      setStale(data.stale ?? false);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to load calendar.");
      setEvents([]);
    } finally {
      setLoading(false);
    }
  }, [from, to, currencies, impact]);

  // Debounce filter changes
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(loadEvents, 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [loadEvents]);

  function toggleCurrency(c: string) {
    setCurrencies(prev =>
      prev.includes(c) ? prev.filter(x => x !== c) : [...prev, c]
    );
  }

  return (
    <div className="flex flex-col h-full p-4 space-y-3 overflow-y-auto">
      {/* Header */}
      <div>
        <h1 className="text-sm font-semibold text-gray-100">ForEx News</h1>
        <p className="text-[11px] text-zinc-500 mt-0.5">
          Economic calendar — high-impact events for traded pairs
        </p>
      </div>

      {/* Upcoming banner */}
      <UpcomingEventsBanner />

      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-3 rounded border border-zinc-800 bg-zinc-900/50 px-3 py-2">
        {/* Currency toggle chips */}
        <div className="flex items-center gap-1.5">
          <span className="text-[10px] text-zinc-500 uppercase tracking-wide mr-1">Currency</span>
          {ALL_CURRENCIES.map(c => (
            <button
              key={c}
              onClick={() => toggleCurrency(c)}
              className={[
                "rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors border",
                currencies.includes(c)
                  ? "bg-blue-900/40 border-blue-700 text-blue-300"
                  : "bg-zinc-800 border-zinc-700 text-zinc-500 hover:border-zinc-600",
              ].join(" ")}
            >
              {c}
            </button>
          ))}
        </div>

        {/* Divider */}
        <div className="h-4 w-px bg-zinc-700" />

        {/* Impact filter */}
        <div className="flex items-center gap-1.5">
          <span className="text-[10px] text-zinc-500 uppercase tracking-wide mr-1">Impact</span>
          {(["all", "high", "medium", "low"] as ImpactFilter[]).map(opt => (
            <button
              key={opt}
              onClick={() => setImpact(opt)}
              className={[
                "rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors border capitalize",
                impact === opt
                  ? "bg-blue-900/40 border-blue-700 text-blue-300"
                  : "bg-zinc-800 border-zinc-700 text-zinc-500 hover:border-zinc-600",
              ].join(" ")}
            >
              {opt === "all" ? "All" : opt === "high" ? "🔴 High" : opt === "medium" ? "🟡 Medium" : "⚪ Low"}
            </button>
          ))}
        </div>

        {/* Divider */}
        <div className="h-4 w-px bg-zinc-700" />

        {/* Date range */}
        <div className="flex items-center gap-1.5">
          <span className="text-[10px] text-zinc-500 uppercase tracking-wide">From</span>
          <input
            type="date"
            value={from}
            onChange={e => setFrom(e.target.value)}
            className="bg-zinc-800 border border-zinc-600 rounded px-2 py-0.5 text-xs text-zinc-200"
          />
          <span className="text-[10px] text-zinc-500 uppercase tracking-wide">To</span>
          <input
            type="date"
            value={to}
            onChange={e => setTo(e.target.value)}
            className="bg-zinc-800 border border-zinc-600 rounded px-2 py-0.5 text-xs text-zinc-200"
          />
        </div>

        {/* Stale indicator */}
        {stale && (
          <span className="ml-auto text-[10px] text-yellow-500">
            ⚠ Calendar feed unavailable — showing cached data
          </span>
        )}
      </div>

      {/* Error */}
      {error && (
        <div className="rounded border border-red-800 bg-red-900/20 px-3 py-2 text-xs text-red-400">
          {error}
        </div>
      )}

      {/* Table */}
      <NewsCalendarTable events={events} loading={loading} />

      {/* Count footer */}
      {!loading && events.length > 0 && (
        <div className="text-[10px] text-zinc-600 text-right">
          {events.length} event{events.length !== 1 ? "s" : ""}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Default export — AuthGuard + Suspense wrapper
// ---------------------------------------------------------------------------

export default function NewsPage() {
  return (
    <AuthGuard>
      <Suspense>
        <NewsPageInner />
      </Suspense>
    </AuthGuard>
  );
}
