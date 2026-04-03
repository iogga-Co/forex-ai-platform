import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        // Design tokens — used consistently across all views
        surface: {
          DEFAULT: "#0f1117",  // page background
          raised: "#1a1d27",   // card / panel background
          border: "#2a2d3a",   // subtle borders
        },
        accent: {
          DEFAULT: "#3b82f6",  // primary blue
          hover: "#2563eb",
        },
        profit: "#22c55e",     // green — positive P&L
        loss:   "#ef4444",     // red   — negative P&L
      },
    },
  },
  plugins: [],
};

export default config;
