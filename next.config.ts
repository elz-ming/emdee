import type { NextConfig } from "next";

const config: NextConfig = {
  // Allow @toast-ui/editor and cytoscape to load in client components
  transpilePackages: ["@toast-ui/editor"],
  // Disable webpack persistent cache — Next.js 15 + Vercel build cache combo
  // serves stale route handlers across deploys. Upgrade to Next 16 (Turbopack)
  // to remove this workaround.
  webpack: (config) => {
    config.cache = false;
    return config;
  },
};

export default config;
