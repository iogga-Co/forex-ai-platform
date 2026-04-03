"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const NAV_ITEMS = [
  { href: "/dashboard",   label: "Dashboard",   phase: null },
  { href: "/backtest",    label: "Backtest",     phase: 1 },
  { href: "/strategies",  label: "Strategies",   phase: 2 },
  { href: "/copilot",     label: "AI Co-Pilot",  phase: 2 },
  { href: "/live",        label: "Live Trading", phase: 4 },
] as const;

export default function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="w-56 shrink-0 border-r border-surface-border bg-surface-raised flex flex-col">
      {/* Logo / wordmark */}
      <div className="px-5 py-5 border-b border-surface-border">
        <span className="text-sm font-semibold tracking-wide text-gray-100">
          Forex AI Platform
        </span>
      </div>

      {/* Navigation */}
      <nav className="flex-1 px-3 py-4 space-y-1">
        {NAV_ITEMS.map(({ href, label, phase }) => {
          const active = pathname.startsWith(href);
          return (
            <Link
              key={href}
              href={href}
              className={[
                "flex items-center justify-between rounded-md px-3 py-2 text-sm transition-colors",
                active
                  ? "bg-accent text-white"
                  : "text-gray-400 hover:bg-surface hover:text-gray-100",
              ].join(" ")}
            >
              <span>{label}</span>
              {phase && (
                <span className="text-[10px] text-gray-500">Ph {phase}</span>
              )}
            </Link>
          );
        })}
      </nav>

      {/* Live trading indicator */}
      <div className="px-5 py-4 border-t border-surface-border">
        <div className="flex items-center gap-2">
          <span className="h-2 w-2 rounded-full bg-gray-600" />
          <span className="text-xs text-gray-500">Live trading off</span>
        </div>
      </div>
    </aside>
  );
}
