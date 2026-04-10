"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";

/**
 * Wraps all pages except /login.
 * On first render it renders nothing (blank) while it checks localStorage.
 * If no token is found it redirects to /login before anything is painted.
 */
export default function AuthGuard({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (pathname === "/login") {
      setReady(true);
      return;
    }
    if (!localStorage.getItem("access_token")) {
      router.replace("/login");
    } else {
      setReady(true);
    }
  }, [pathname, router]);

  if (!ready) return null;
  return <>{children}</>;
}
