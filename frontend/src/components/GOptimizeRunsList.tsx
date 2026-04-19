"use client";

import { useEffect, useRef, useState } from "react";
import type { GOptimizeRun } from "@/lib/gOptimizeTypes";

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
}

function pairsLabel(pairs: string[]): string {
  if (pairs.length === 6) return "ALL pairs";
  if (pairs.length <= 2) return pairs.join(" + ");
  return pairs.slice(0, 2).join(" + ") + ` +${pairs.length - 2}`;
}

function fmtEta(seconds: number): string {
  if (!isFinite(seconds) || seconds <= 0) return "";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `~${h}h ${m}m left`;
  if (m > 0) return `~${m}m left`;
  return "<1m left";
}

function StatusBadge({ status }: { status: string }) {
  const dot = status === "running" || status === "done" ? "●" : "○";
  const color =
    status === "running" ? "text-blue-400" :
    status === "done"    ? "text-green-400" :
    status === "failed"  ? "text-red-400"   : "text-zinc-500";
  const label =
    status === "running" ? "Running" :
    status === "done"    ? "Done"    :
    status === "stopped" ? "Stopped" :
    status === "failed"  ? "Failed"  : "Pending";
  return <span className={`text-[10px] ${color}`}>{dot} {label}</span>;
}

// ---------------------------------------------------------------------------
// SSE progress overlay — live data received from Redis pub/sub
// ---------------------------------------------------------------------------
interface LiveProgress {
  configs_done:   number;
  configs_total:  number;
  configs_passed: number;
  startedAt:      number; // Date.now() when SSE connected
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------
interface Props {
  runs:          GOptimizeRun[];
  selectedId:    string | null;
  checkedIds:    Set<string>;
  loading:       boolean;
  onSelect:      (run: GOptimizeRun) => void;
  onCheck:       (id: string, checked: boolean) => void;
  onNewRun:      () => void;
  onStopRun:     (id: string) => Promise<void>;
  onRunDone:     (id: string) => void;
  onRunDeleted:  (id: string) => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------
export default function GOptimizeRunsList({
  runs, selectedId, checkedIds, loading,
  onSelect, onCheck, onNewRun, onStopRun, onRunDone, onRunDeleted,
}: Props) {
  // live SSE progress keyed by run id
  const [liveProgress, setLiveProgress] = useState<Record<string, LiveProgress>>({});
  const [stopping,     setStopping]     = useState<Record<string, boolean>>({});
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; number: number } | null>(null);
  const [deleting,     setDeleting]     = useState(false);
  const esRefs = useRef<Record<string, EventSource>>({});

  // Open/close SSE connections as running runs appear/disappear
  useEffect(() => {
    const runningIds = new Set(runs.filter((r) => r.status === "running").map((r) => r.id));

    // Open new connections
    runningIds.forEach((id) => {
      if (esRefs.current[id]) return; // already connected
      const token  = localStorage.getItem("access_token") ?? "";
      const url    = `${API_BASE}/api/g-optimize/runs/${id}/stream?token=${encodeURIComponent(token)}`;
      const es     = new EventSource(url);
      esRefs.current[id] = es;

      setLiveProgress((prev) => ({
        ...prev,
        [id]: { configs_done: 0, configs_total: 0, configs_passed: 0, startedAt: Date.now() },
      }));

      es.addEventListener("progress", (e) => {
        try {
          const data = JSON.parse(e.data);
          setLiveProgress((prev) => ({
            ...prev,
            [id]: {
              configs_done:   data.configs_done   ?? prev[id]?.configs_done   ?? 0,
              configs_total:  data.configs_total  ?? prev[id]?.configs_total  ?? 0,
              configs_passed: data.configs_passed ?? prev[id]?.configs_passed ?? 0,
              startedAt:      prev[id]?.startedAt ?? Date.now(),
            },
          }));
        } catch { /* ignore */ }
      });

      es.addEventListener("done", () => {
        es.close();
        delete esRefs.current[id];
        onRunDone(id);
      });

      es.addEventListener("error", () => {
        es.close();
        delete esRefs.current[id];
      });
    });

    // Close connections for runs no longer running
    Object.keys(esRefs.current).forEach((id) => {
      if (!runningIds.has(id)) {
        esRefs.current[id].close();
        delete esRefs.current[id];
      }
    });
  }, [runs, onRunDone]);

  // Cleanup on unmount — capture ref value inside effect to satisfy lint rule
  useEffect(() => {
    const refs = esRefs.current;
    return () => { Object.values(refs).forEach((es) => es.close()); };
  }, []);

  async function handleStop(e: React.MouseEvent, runId: string) {
    e.stopPropagation();
    setStopping((prev) => ({ ...prev, [runId]: true }));
    try {
      await onStopRun(runId);
    } finally {
      setStopping((prev) => ({ ...prev, [runId]: false }));
    }
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await fetch(`${API_BASE}/api/g-optimize/runs/${deleteTarget.id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${localStorage.getItem("access_token") ?? ""}` },
      });
      onRunDeleted(deleteTarget.id);
      setDeleteTarget(null);
    } catch { /* non-fatal */ }
    finally { setDeleting(false); }
  }

  const total = runs.length;

  return (
    <div className="w-56 shrink-0 border-r border-zinc-800 flex flex-col overflow-hidden relative">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-zinc-800">
        <span className="text-[11px] font-semibold text-zinc-300 uppercase tracking-wide">
          Runs
        </span>
        <button
          onClick={onNewRun}
          className="rounded border border-blue-700 px-1.5 py-0.5 text-[10px] text-blue-400 hover:bg-blue-900/30 transition-colors"
        >
          + New Run
        </button>
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto">
        {loading && (
          <div className="px-3 py-4 text-[11px] text-zinc-500">Loading…</div>
        )}

        {!loading && runs.length === 0 && (
          <div className="px-3 py-4 text-[11px] text-zinc-500">
            No runs yet. Click&nbsp;<strong>+ New Run</strong> to start.
          </div>
        )}

        {!loading && runs.map((run, idx) => {
          const runNumber  = total - idx;
          const isSelected = run.id === selectedId;
          const isChecked  = checkedIds.has(run.id);
          const live       = liveProgress[run.id];
          const isRunning  = run.status === "running";

          // Use live SSE progress if available, else fall back to DB values
          const done   = live?.configs_done   ?? run.configs_done;
          const ttl    = live?.configs_total  ?? run.configs_total;
          const passed = live?.configs_passed ?? run.configs_passed;
          const pct    = ttl > 0 ? Math.min(100, Math.round((done / ttl) * 100)) : null;

          // ETA from elapsed time + progress rate
          let etaStr = "";
          if (isRunning && live && done > 0 && ttl > 0) {
            const elapsedSec = (Date.now() - live.startedAt) / 1000;
            const rate       = done / elapsedSec;          // backtests/sec
            const remaining  = (ttl - done) / rate;        // seconds left
            etaStr           = fmtEta(remaining);
          }

          return (
            <div
              key={run.id}
              onClick={() => onSelect(run)}
              className={[
                "px-3 py-2 border-b border-zinc-800/60 cursor-pointer transition-colors",
                isSelected ? "bg-blue-900/30" :
                isChecked  ? "bg-blue-900/10"  : "hover:bg-zinc-800/50",
              ].join(" ")}
            >
              <div className="flex items-start gap-1.5">
                {/* Checkbox */}
                <input
                  type="checkbox"
                  checked={isChecked}
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => onCheck(run.id, e.target.checked)}
                  className="h-3 w-3 mt-0.5 accent-blue-500 shrink-0 cursor-pointer"
                />
                <div className="min-w-0 flex-1">
                  {/* Run number + date */}
                  <div className="flex items-center justify-between gap-1">
                    <span className="text-[11px] font-medium text-zinc-200">
                      Run #{runNumber}
                    </span>
                    <span className="text-[10px] text-zinc-500 shrink-0">
                      {fmtDate(run.created_at)}
                    </span>
                  </div>

                  {/* Pairs + timeframe */}
                  <div className="text-[10px] text-zinc-400 truncate">
                    {pairsLabel(run.pairs)} · {run.timeframe}
                  </div>

                  {/* Config count */}
                  <div className="text-[10px] text-zinc-500">
                    {run.n_configs.toLocaleString()} configs
                  </div>

                  {/* Live progress bar */}
                  {isRunning && pct !== null && (
                    <div className="mt-1">
                      <div className="h-1 bg-zinc-700 rounded-full overflow-hidden">
                        <div
                          className="h-full bg-blue-500 transition-all duration-500"
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                      <div className="flex items-center justify-between mt-0.5">
                        <span className="text-[9px] text-zinc-500">{pct}%</span>
                        {etaStr && (
                          <span className="text-[9px] text-zinc-500">{etaStr}</span>
                        )}
                      </div>
                    </div>
                  )}

                  {/* Passed count + status + stop/delete buttons */}
                  <div className="flex items-center justify-between mt-0.5">
                    <div className="flex items-center gap-1.5">
                      {(isRunning || run.status === "done" || run.status === "stopped") && (
                        <span className="text-[10px] text-zinc-400">
                          {passed} passed
                        </span>
                      )}
                      <StatusBadge status={run.status} />
                    </div>
                    <div className="flex items-center gap-1">
                      {isRunning && (
                        <button
                          onClick={(e) => handleStop(e, run.id)}
                          disabled={stopping[run.id]}
                          className="rounded border border-zinc-600 px-1 py-0.5 text-[9px] text-zinc-400 hover:border-red-700 hover:text-red-400 disabled:opacity-40 transition-colors"
                        >
                          {stopping[run.id] ? "…" : "Stop"}
                        </button>
                      )}
                      {!isRunning && (
                        <button
                          onClick={(e) => { e.stopPropagation(); setDeleteTarget({ id: run.id, number: runNumber }); }}
                          className="rounded border border-zinc-700 p-0.5 text-zinc-600 hover:border-red-800 hover:text-red-400 transition-colors"
                          title="Delete run"
                        >
                          <svg className="h-3 w-3" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5">
                            <path d="M2 3h8M5 3V2h2v1M4 3v6h4V3M5 5v3M7 5v3" />
                          </svg>
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* ── Delete confirmation modal ───────────────────────────────── */}
      {deleteTarget && (
        <div
          className="absolute inset-0 z-20 flex items-center justify-center bg-black/60"
          onClick={() => !deleting && setDeleteTarget(null)}
        >
          <div
            className="bg-zinc-900 border border-zinc-700 rounded p-4 w-48 space-y-3 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="text-[11px] font-semibold text-zinc-200">
              Delete Run #{deleteTarget.number}?
            </div>
            <p className="text-[10px] text-zinc-500">
              Removes the run and all its backtest results. Strategies already promoted to RAG are kept.
            </p>
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => setDeleteTarget(null)}
                disabled={deleting}
                className="rounded border border-zinc-700 px-2 py-0.5 text-[10px] text-zinc-400 hover:bg-zinc-800 disabled:opacity-40 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={confirmDelete}
                disabled={deleting}
                className="rounded border border-red-800 px-2 py-0.5 text-[10px] text-red-400 hover:bg-red-900/30 disabled:opacity-40 transition-colors"
              >
                {deleting ? "Deleting…" : "Delete"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
