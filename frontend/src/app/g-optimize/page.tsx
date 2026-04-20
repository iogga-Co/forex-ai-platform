"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { fetchWithAuth } from "@/lib/auth";
import GOptimizeRunConfig from "@/components/GOptimizeRunConfig";
import GOptimizeRunsList from "@/components/GOptimizeRunsList";
import GOptimizeStrategies from "@/components/GOptimizeStrategies";
import GOptimizeCopilotPanel from "@/components/GOptimizeCopilotPanel";
import type { GOptimizeRun } from "@/lib/gOptimizeTypes";

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "";

export default function GOptimizePage() {
  return (
    <Suspense>
      <GOptimizeInner />
    </Suspense>
  );
}

function GOptimizeInner() {
  useSearchParams();

  const [runs,           setRuns]           = useState<GOptimizeRun[]>([]);
  const [runsLoading,    setRunsLoading]    = useState(true);
  const [selectedRun,    setSelectedRun]    = useState<GOptimizeRun | null>(null);
  const [checkedRunIds,  setCheckedRunIds]  = useState<Set<string>>(new Set());
  const [checkedStratIds, setCheckedStratIds] = useState<Set<string>>(new Set());
  const [showConfig,     setShowConfig]     = useState(false);

  // -------------------------------------------------------------------------
  // Derive which run IDs the strategies panel should show:
  // checked runs take priority; fall back to selected run.
  // -------------------------------------------------------------------------
  const targetRunIds: string[] =
    checkedRunIds.size > 0
      ? Array.from(checkedRunIds)
      : selectedRun
      ? [selectedRun.id]
      : [];

  // -------------------------------------------------------------------------
  // Data loading
  // -------------------------------------------------------------------------
  const loadRuns = useCallback(async () => {
    setRunsLoading(true);
    try {
      const res = await fetchWithAuth(`${API_BASE}/api/g-optimize/runs`);
      if (res.ok) setRuns(await res.json());
    } catch { /* non-fatal */ }
    finally { setRunsLoading(false); }
  }, []);

  useEffect(() => { loadRuns(); }, [loadRuns]);

  // -------------------------------------------------------------------------
  // Handlers
  // -------------------------------------------------------------------------
  function handleSelect(run: GOptimizeRun) {
    setSelectedRun(run);
    setShowConfig(false);
  }

  function handleCheckRun(id: string, checked: boolean) {
    setCheckedRunIds((prev) => {
      const next = new Set(prev);
      if (checked) { next.add(id); } else { next.delete(id); }
      return next;
    });
  }

  function handleNewRun() {
    setSelectedRun(null);
    setShowConfig(true);
  }

  function handleRunCreated(run: GOptimizeRun) {
    setRuns((prev) => [run, ...prev]);
    setShowConfig(false);
    setSelectedRun(run);
  }

  async function handleStopRun(id: string) {
    await fetchWithAuth(`${API_BASE}/api/g-optimize/runs/${id}/stop`, { method: "POST" });
  }

  function handleRunDeleted(id: string) {
    setRuns((prev) => prev.filter((r) => r.id !== id));
    if (selectedRun?.id === id) setSelectedRun(null);
    setCheckedRunIds((prev) => { const n = new Set(prev); n.delete(id); return n; });
  }

  async function handleRunDone(id: string) {
    try {
      const res = await fetchWithAuth(`${API_BASE}/api/g-optimize/runs/${id}`);
      if (res.ok) {
        const updated: GOptimizeRun = await res.json();
        setRuns((prev) => prev.map((r) => r.id === id ? updated : r));
        if (selectedRun?.id === id) setSelectedRun(updated);
      }
    } catch { /* non-fatal */ }
  }

  function handleStrategyCheck(id: string, checked: boolean) {
    setCheckedStratIds((prev) => {
      const next = new Set(prev);
      if (checked) { next.add(id); } else { next.delete(id); }
      return next;
    });
  }

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------
  return (
    <div className="flex h-full overflow-hidden -m-1">
      <div className="flex flex-col flex-1 overflow-hidden">

        {/* ── TOP: Run Config panel ─────────────────────────────────── */}
        {showConfig && (
          <div className="shrink-0 border-b border-zinc-800 bg-zinc-900/50 max-h-[70vh] flex flex-col overflow-hidden">
            <div className="flex items-center justify-between px-4 py-2 border-b border-zinc-800 shrink-0">
              <span className="text-[11px] font-semibold text-zinc-300 uppercase tracking-wide">
                New G-Optimize Run
              </span>
              <button
                onClick={() => setShowConfig(false)}
                className="text-[10px] text-zinc-500 hover:text-zinc-300 transition-colors"
              >
                ✕ Close
              </button>
            </div>
            <GOptimizeRunConfig
              onCreated={handleRunCreated}
              onCancel={() => setShowConfig(false)}
            />
          </div>
        )}

        {/* ── MIDDLE: Runs list (left) + Strategies panel (right) ───── */}
        <div className="flex flex-1 overflow-hidden">
          <GOptimizeRunsList
            runs={runs}
            selectedId={selectedRun?.id ?? null}
            checkedIds={checkedRunIds}
            loading={runsLoading}
            onSelect={handleSelect}
            onCheck={handleCheckRun}
            onNewRun={handleNewRun}
            onStopRun={handleStopRun}
            onRunDone={handleRunDone}
            onRunDeleted={handleRunDeleted}
          />

          <div className="flex-1 overflow-hidden flex flex-col">
            {targetRunIds.length > 0 ? (
              <GOptimizeStrategies
                targetRunIds={targetRunIds}
                runs={runs}
                checkedIds={checkedStratIds}
                onCheck={handleStrategyCheck}
                onClearAll={() => setCheckedStratIds(new Set())}
              />
            ) : (
              <div className="flex items-center justify-center flex-1 text-[11px] text-zinc-600">
                Select a run to view its strategies, or click&nbsp;
                <button
                  onClick={handleNewRun}
                  className="ml-1 text-blue-500 hover:text-blue-400 transition-colors"
                >
                  + New Run
                </button>
                &nbsp;to start a discovery run.
              </div>
            )}
          </div>
        </div>

        {/* ── BOTTOM: Co-Pilot Analysis panel ───────────────────────── */}
        <GOptimizeCopilotPanel
          checkedStrategyIds={checkedStratIds}
          checkedRunIds={checkedRunIds}
          targetRunIds={targetRunIds}
          runs={runs}
        />

      </div>
    </div>
  );
}
