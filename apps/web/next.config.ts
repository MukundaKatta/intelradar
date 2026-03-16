import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@intelradar/supabase", "@intelradar/ai-analyst", "@intelradar/monitors"],
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "**" },
    ],
  },
  experimental: {
    serverActions: {
      bodySizeLimit: "2mb",
    },
  },
};

export default nextConfig;
