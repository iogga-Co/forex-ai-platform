"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { fetchWithAuth } from "@/lib/auth";
import type { GOptimizeRun } from "@/lib/gOptimizeTypes";

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "";
const POLL_INTERVAL_MS = 10_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function fmtDate(iso: string | null): string {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
}

function fmtEta(donePct: number, elapsedMs: number): string {
  if (donePct <= 0 || donePct >= 100) return "";
  const totalMs  = elapsedMs / (donePct / 100);
  const leftSec  = Math.round((totalMs - elapsedMs) / 1000);
  if (leftSec <= 0) return "";
  const h = Math.floor(leftSec / 3600);
  const m = Math.floor((leftSec % 3600) / 60);
  return h > 0 ? `~${h}h ${m}m` : m > 0 ? `~${m}m` : "<1m";
}

// ---------------------------------------------------------------------------
// Widget
// ---------------------------------------------------------------------------
export default function GOptimizeProgressWidget() {
  const [activeRun,    setActiveRun]    = useState<GOptimizeRun | null>(null);
  const [lastDoneRun,  setLastDoneRun]  = useState<GOptimizeRun | null>(null);
  const [stopping,     setStopping]     = useState(false);
  const startTimeRef   = useRef<number | null>(null);
  const [, setTick]    = useState(0); // forces re-render for ETA updates

  const load = useCallback(async () => {
    try {
      const res = await fetchWithAuth(`${API_BASE}/api/g-optimize/runs?limit=10`);
      if (!res.ok) return;
      const runs: GOptimizeRun[] = await res.json();
      const running = runs.find((r) => r.status === "running") ?? null;
      const done    = runs.find((r) => r.status === "done")    ?? null;
      if (running && !startTimeRef.current) {
        startTimeRef.current = Date.now();
      }
      if (!running) startTimeRef.current = null;
      setActiveRun(running);
      setLastDoneRun(done);
    } catch { /* non-fatal — widget is optional */ }
  }, []);

  // Initial load
  useEffect(() => { load(); }, [load]);

  // Poll every 10s while a run is active; stop when idle
  useEffect(() => {
    if (!activeRun) return;
    const id = setInterval(() => {
      load();
      setTick((t) => t + 1); // also ticks ETA display
    }, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [activeRun, load]);

  // ETA tick every 30s independent of polling
  useEffect(() => {
    if (!activeRun) return;
    const id = setInterval(() => setTick((t) => t + 1), 30_000);
    return () => clearInterval(id);
  }, [activeRun]);

  async function handleStop(e: React.MouseEvent) {
    e.preventDefault();
    if (!activeRun) return;
    setStopping(true);
    try {
      await fetchWithAuth(`${API_BASE}/api/g-optimize/runs/${activeRun.id}/stop`, { method: "POST" });
      await load();
    } finally {
      setStopping(false);
    }
  }

  // Nothing to show
  if (!activeRun && !lastDoneRun) return null;

  const total   = activeRun?.configs_total  ?? 0;
  const done    = activeRun?.configs_done   ?? 0;
  const passed  = activeRun?.configs_passed ?? 0;
  const pct     = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
  const elapsed = startTimeRef.current ? Date.now() - startTimeRef.current : 0;
  const eta     = fmtEta(pct, elapsed);

  return (
    <div className="rounded border border-zinc-700 bg-zinc-800/50 p-3 space-y-2">
      <div className="text-[10px] font-semibold text-zinc-400 uppercase tracking-wide">
        G-Optimize
      </div>

      {/* Active run */}
      {activeRun && (
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <span className="text-[11px] text-zinc-300 truncate">
              {activeRun.pairs.length === 6 ? "ALL pairs" : activeRun.pairs.slice(0, 2).join(" + ")}
              {" · "}{activeRun.timeframe}
            </span>
            <button
              onClick={handleStop}
              disabled={stopping}
              className="rounded border border-zinc-600 px-1.5 py-0.5 text-[9px] text-zinc-400 hover:border-red-700 hover:text-red-400 disabled:opacity-40 transition-colors shrink-0 ml-2"
            >
              {stopping ? "…" : "Stop"}
            </button>
          </div>

          {/* Progress bar */}
          <div>
            <div className="h-1.5 bg-zinc-700 rounded-full overflow-hidden">
              <div
                className="h-full bg-blue-500 transition-all duration-500"
                style={{ width: `${pct}%` }}
              />
            </div>
            <div className="flex items-center justify-between mt-0.5">
              <span className="text-[10px] text-zinc-400">
                {pct}%{" "}
                <span className="text-zinc-600">
                  ({done.toLocaleString()} / {total.toLocaleString()} backtests)
                </span>
              </span>
              <span className="text-[10px] text-zinc-500 ml-2">{eta}</span>
            </div>
          </div>

          <div className="text-[10px] text-zinc-400">
            Passed so far: <span className="text-green-400 font-medium">{passed}</span>
          </div>
        </div>
      )}

      {/* Last completed run */}
      {lastDoneRun && !activeRun && (
        <div className="flex items-center justify-between gap-2">
          <span className="text-[10px] text-zinc-400 truncate">
            Last: {fmtDate(lastDoneRun.completed_at ?? lastDoneRun.created_at)}
            {" · "}{lastDoneRun.configs_passed} passed
            {" / "}{lastDoneRun.configs_total.toLocaleString()} tested
          </span>
          <Link
            href="/g-optimize"
            className="shrink-0 rounded border border-blue-700 px-1.5 py-0.5 text-[10px] text-blue-400 hover:bg-blue-900/30 transition-colors"
          >
            View →
          </Link>
        </div>
      )}
    </div>
  );
}
