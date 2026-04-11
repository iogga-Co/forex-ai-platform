"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";
import {
  clearAccessToken,
  getAccessToken,
  isTokenExpiringSoon,
  refreshAccessToken,
} from "@/lib/auth";

/**
 * Client-side auth guard with silent token refresh.
 *
 * On every route change:
 *  - If no token → redirect to /login immediately.
 *  - If token is expiring within 2 minutes → silently refresh it.
 *
 * Also runs a 60-second interval so a tab left open overnight gets
 * refreshed proactively rather than hitting a 401 on the next action.
 */
export default function AuthGuard({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();

  useEffect(() => {
    if (pathname === "/login") return;

    const token = getAccessToken();
    if (!token) {
      clearAccessToken();
      router.replace("/login");
      return;
    }

    if (isTokenExpiringSoon(token)) {
      refreshAccessToken().catch(() => {
        clearAccessToken();
        router.replace("/login");
      });
    }
  }, [pathname, router]);

  useEffect(() => {
    if (pathname === "/login") return;

    const interval = setInterval(() => {
      const token = getAccessToken();
      if (!token) return;
      if (isTokenExpiringSoon(token)) {
        refreshAccessToken().catch(() => {
          clearAccessToken();
          router.replace("/login");
        });
      }
    }, 60_000);

    return () => clearInterval(interval);
  }, [pathname, router]);

  return <>{children}</>;
}
