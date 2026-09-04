import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  /*
   * 线上读库，不要把 CSV / 72MB 面板按路由打进函数包。
   * 不同 outputFileTracingIncludes 会拆成多个 Serverless Function，
   * Hobby 上限 12 个；再叠 data/ 体积还会超 250MB。
   */
  outputFileTracingIncludes: {
    "*": ["data/rps-latest.json", "data/desk/**"],
  },
  outputFileTracingExcludes: {
    "*": [
      "data/smallfund/**",
      "data/smallfund4h/**",
      "data/smallfund2h/**",
      "data/smallfund1h/**",
      "data/benchmarks/**",
      ".cache/**",
      "scripts/**",
      "tests/**",
      "docs/**",
    ],
  },
};

export default nextConfig;
