import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  transpilePackages: ["@toast-ui/editor"],
  turbopack: {
    root: path.resolve(import.meta.dirname),
  },
};

export default nextConfig;
