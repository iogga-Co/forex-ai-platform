"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";

const NAV_ITEMS = [
  { href: "/dashboard",    label: "Dashboard"    },
  { href: "/superchart",   label: "Superchart"   },
  { href: "/backtest",     label: "Backtest"     },
  { href: "/strategies",   label: "Strategies"   },
  { href: "/copilot",      label: "AI Co-Pilot"  },
  { href: "/optimization", label: "Optimize"     },
  { href: "/news",         label: "ForEx News"   },
  { href: "/g-optimize",  label: "G-Optimize"   },
  { href: "/lab",          label: "Indicator Lab"},
  { href: "/live",         label: "Live Trading" },
] as const;

export default function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const [loggedIn, setLoggedIn] = useState(false);

  useEffect(() => {
    setLoggedIn(!!localStorage.getItem("access_token"));
  }, [pathname]);

  function handleLogout() {
    localStorage.removeItem("access_token");
    router.push("/login");
  }

  // Don't render sidebar on login page
  if (pathname === "/login") return null;

  return (
    <aside className="w-28 shrink-0 border-r border-surface-border bg-surface-raised flex flex-col">
      {/* Logo / wordmark */}
      <div className="px-3 py-3 border-b border-surface-border">
        <span className="text-sm font-semibold tracking-wide text-gray-100">
          Forex AI Platform
        </span>
      </div>

      {/* Navigation */}
      <nav className="flex-1 px-3 py-4 space-y-1">
        {NAV_ITEMS.map(({ href, label }) => {
          const active = pathname.startsWith(href);
          return (
            <Link
              key={href}
              href={href}
              className={[
                "flex items-center justify-between rounded-md pl-2 pr-1 py-1.5 text-[14px] whitespace-nowrap transition-colors",
                active
                  ? "bg-accent text-white"
                  : "text-gray-400 hover:bg-surface hover:text-gray-100",
              ].join(" ")}
            >
              <span>{label}</span>
            </Link>
          );
        })}
      </nav>

      {/* Footer */}
      <div className="px-3 py-3 border-t border-surface-border space-y-2">
        <div className="flex items-center gap-2">
          <span className="h-2 w-2 rounded-full bg-yellow-600" />
          <span className="text-xs text-gray-500">Shadow mode</span>
        </div>
        <div className="flex items-center justify-between">
          {loggedIn ? (
            <button
              onClick={handleLogout}
              className="text-xs text-gray-500 hover:text-gray-300 transition-colors"
            >
              Sign out
            </button>
          ) : (
            <Link href="/login" className="text-xs text-blue-400 hover:underline">
              Sign in
            </Link>
          )}
          <Link
            href="/settings"
            title="Settings"
            className={`p-1 rounded transition-colors ${
              pathname.startsWith("/settings")
                ? "text-white bg-accent"
                : "text-gray-500 hover:text-gray-300"
            }`}
          >
            <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
          </Link>
        </div>
      </div>
    </aside>
  );
}
