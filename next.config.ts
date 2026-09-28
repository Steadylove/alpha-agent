import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  allowedDevOrigins: ["127.0.0.1"],
  /*
   * 线上读行情机 / 本地 CSV，不要把整池 CSV / 72MB 面板按路由打进函数包。
   * 不同 outputFileTracingIncludes 会拆成多个 Serverless Function，
   * Hobby 上限 12 个；再叠 data/ 体积还会超 250MB。
   */
  outputFileTracingIncludes: {
    "*": ["data/desk/**"],
  },
  outputFileTracingExcludes: {
    "*": [
      "data/smallfund/**",
      "data/smallfund4h/**",
      "data/smallfund2h/**",
      "data/smallfund1h/**",
      "data/benchmarks/**",
      "data/intraday-research/**",
      ".cache/**",
      ".env*",
      "**/web-secrets*.json",
      "scripts/**",
      "tests/**",
      "docs/**",
    ],
  },
};

export default nextConfig;
