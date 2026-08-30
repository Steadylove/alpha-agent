import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  /*
   * 面板快照要随函数一起部署。
   *
   * 它是运行时用 `path.join(process.cwd(), ".cache", ...)` 拼出来读的，
   * 这种动态路径打包器分析不出来，不显式列出就不会进函数包。
   */
  outputFileTracingIncludes: {
    "/api/lab/backtest": [
      ".cache/backtest-panel.v8",
      "data/smallfund/**",
      "data/smallfund4h/**",
      "data/benchmarks/**",
    ],
    "/api/lab/chart": [
      ".cache/backtest-panel.v8",
      "data/smallfund/**",
      "data/smallfund4h/**",
      "data/benchmarks/**",
    ],
    "/api/desk/signals": [
      "data/smallfund/**",
      "data/smallfund4h/**",
    ],
    "/api/tv/alert": [
      "data/smallfund/**",
      "data/smallfund4h/**",
    ],
  },
};

export default nextConfig;
