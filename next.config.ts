import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  eslint: {
    // Lint is run explicitly via `npm run lint`; keep the production build
    // focused on type-checking and compilation for a deterministic baseline.
    ignoreDuringBuilds: true,
  },
};

export default nextConfig;
