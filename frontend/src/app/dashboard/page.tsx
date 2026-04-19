"use client";

import GOptimizeProgressWidget from "@/components/GOptimizeProgressWidget";

export default function DashboardPage() {
  return (
    <div className="max-w-xl space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-gray-100 mb-1">Dashboard</h1>
        <p className="text-sm text-gray-500">
          Overview of active strategies, recent backtest results, and system status.
        </p>
      </div>

      <GOptimizeProgressWidget />
    </div>
  );
}
