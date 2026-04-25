"use client";

import { useEffect } from "react";
import { loadSettings } from "@/lib/settings";

export default function DensityProvider() {
  useEffect(() => {
    function apply() {
      const density = loadSettings().ui_density ?? "compact";
      document.documentElement.classList.toggle("spacious", density === "spacious");
    }
    apply();
    // Re-apply when storage changes (e.g. settings saved in another tab)
    window.addEventListener("storage", apply);
    return () => window.removeEventListener("storage", apply);
  }, []);

  return null;
}
