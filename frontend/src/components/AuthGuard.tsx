"use client";

import { usePathname } from "next/navigation";
import { useState } from "react";

/**
 * Wraps all pages except /login.
 * The auth check runs synchronously inside the useState initializer —
 * before the first render — so the browser never paints protected content
 * for unauthenticated users. window.location.replace navigates immediately
 * without adding a history entry.
 */
export default function AuthGuard({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  const [ready] = useState<boolean>(() => {
    if (typeof window === "undefined") return false; // SSR: wait for client
    if (window.location.pathname === "/login") return true;
    if (!localStorage.getItem("access_token")) {
      window.location.replace("/login");
      return false;
    }
    return true;
  });

  // Re-check on in-app navigation (the initializer only runs once on mount).
  if (pathname !== "/login" && typeof window !== "undefined" && !localStorage.getItem("access_token")) {
    window.location.replace("/login");
    return null;
  }

  if (!ready) return null;
  return <>{children}</>;
}
