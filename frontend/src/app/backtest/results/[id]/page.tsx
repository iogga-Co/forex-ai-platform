"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import BacktestResultPanel from "@/components/BacktestResultPanel";

export default function BacktestResultPage() {
  const { id } = useParams<{ id: string }>();

  return (
    <div className="max-w-6xl space-y-4">
      <Link
        href="/backtest"
        className="text-xs text-gray-500 hover:text-gray-300 transition-colors"
      >
        ← Back to Backtest
      </Link>
      <BacktestResultPanel id={id} />
    </div>
  );
}
