"use client";

import { useEffect, useState } from "react";
import { fetchWithAuth } from "@/lib/auth";
import type { NewsEvent } from "./NewsCalendarTable";

const REFRESH_MS = 15 * 60 * 1000; // 15 minutes

function formatBannerTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString("en-US", {
    hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC",
  });
}

export default function UpcomingEventsBanner() {
  const [events, setEvents] = useState<NewsEvent[]>([]);

  async function load() {
    const now = new Date();
    const todayStr = now.toISOString().slice(0, 10);
    const tomorrowStr = new Date(now.getTime() + 24 * 60 * 60 * 1000)
      .toISOString().slice(0, 10);
    try {
      const data = await fetchWithAuth(
        `/api/news/calendar?from=${todayStr}&to=${tomorrowStr}&impact=high`
      );
      const upcoming = (data.events as NewsEvent[]).filter(e => !e.is_past);
      setEvents(upcoming);
    } catch {
      // silently ignore — banner is best-effort
    }
  }

  useEffect(() => {
    load();
    const interval = setInterval(load, REFRESH_MS);
    return () => clearInterval(interval);
  }, []);

  if (events.length === 0) return null;

  return (
    <div className="flex items-center gap-2 rounded border border-zinc-700 bg-zinc-900 px-3 py-1.5 overflow-x-auto">
      <span className="shrink-0 text-[10px] font-semibold text-zinc-400 uppercase tracking-wide mr-1">
        Next 24h:
      </span>
      {events.map((ev, i) => (
        <span
          key={i}
          className="shrink-0 flex items-center gap-1 rounded bg-zinc-800 border border-zinc-700 px-2 py-0.5 text-[11px] text-zinc-200 whitespace-nowrap"
        >
          <span>🔴</span>
          <span className="text-zinc-400 font-mono">{formatBannerTime(ev.event_time)}</span>
          <span className="font-semibold text-zinc-100">{ev.currency}</span>
          <span className="text-zinc-300">{ev.title}</span>
        </span>
      ))}
    </div>
  );
}
