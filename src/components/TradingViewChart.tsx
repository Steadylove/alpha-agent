"use client";

import { Card } from "@/components/Card";
import { ScreenerPriceChart } from "@/components/ScreenerPriceChart";
import type { ChartInterval, StockChartData } from "@/lib/dashboard/stockChart";
import type { Playbook } from "@/lib/scoring/rpsPlaybooks";
import { Loader, Text } from "@mantine/core";
import { useEffect, useState } from "react";

type FetchState = {
  key: string;
  data: StockChartData | null;
  error: string | null;
};

/**
 * Screener K 线容器：支持时间级别切换 + 战法辅助线。
 * 父组件请用 key={`${symbol}-${playbook}`}，切换股票/战法时重挂载以重置到日线。
 */
export function TradingViewChart({
  symbol,
  name,
  playbook,
}: {
  symbol: string;
  name?: string | null;
  playbook: Playbook;
}) {
  const [interval, setInterval] = useState<ChartInterval>("1d");
  const [state, setState] = useState<FetchState>({
    key: "",
    data: null,
    error: null,
  });

  const fetchKey = `${symbol}:${playbook}:${interval}`;
  const ready = state.key === fetchKey && state.data != null && !state.error;
  const failed = state.key === fetchKey && state.error != null;

  useEffect(() => {
    let cancelled = false;
    const key = `${symbol}:${playbook}:${interval}`;

    void fetch(
      `/api/chart/${encodeURIComponent(symbol)}?${new URLSearchParams({
        interval,
        playbook,
      }).toString()}`,
    )
      .then(async (res) => {
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error ?? `HTTP ${res.status}`);
        }
        return res.json() as Promise<StockChartData>;
      })
      .then((chart) => {
        if (cancelled) return;
        setState({ key, data: chart, error: null });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setState({
          key,
          data: null,
          error: err instanceof Error ? err.message : String(err),
        });
      });

    return () => {
      cancelled = true;
    };
  }, [symbol, playbook, interval]);

  if (failed) {
    return (
      <Card title={`${symbol}${name ? ` · ${name}` : ""} · Chart`}>
        <div className="flex h-[200px] items-center justify-center">
          <Text size="sm" c="red.4">
            K 线加载失败：{state.error}
          </Text>
        </div>
      </Card>
    );
  }

  if (!ready || !state.data) {
    return (
      <Card title={`${symbol}${name ? ` · ${name}` : ""} · Chart`}>
        <div className="flex h-[480px] items-center justify-center gap-2 text-zinc-500">
          <Loader size="sm" color="gray" />
          <Text size="sm">加载 {interval} K 线中…</Text>
        </div>
      </Card>
    );
  }

  return (
    <ScreenerPriceChart
      data={state.data}
      interval={interval}
      onIntervalChange={setInterval}
    />
  );
}
