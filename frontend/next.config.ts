import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Polling required on Windows Docker — NTFS doesn't propagate inotify events into Linux containers
  webpack: (config, { dev }) => {
    if (dev) {
      config.watchOptions = { poll: 1000, aggregateTimeout: 300 };
    }
    return config;
  },
  // output: "standalone" produces a minimal production image.
  // Enable this when building the production Docker image.
  // output: "standalone",

  // All API calls are proxied through Nginx in production.
  // In local dev, rewrites forward /api/* directly to FastAPI.
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: `${process.env.NEXT_PUBLIC_API_URL ?? "http://fastapi:8000"}/api/:path*`,
      },
      {
        source: "/ws/:path*",
        destination: `${process.env.NEXT_PUBLIC_API_URL ?? "http://fastapi:8000"}/ws/:path*`,
      },
    ];
  },
};

export default nextConfig;
