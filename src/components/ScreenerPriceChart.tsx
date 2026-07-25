"use client";

import { Card } from "@/components/Card";
import type { ChartInterval, StockChartData } from "@/lib/dashboard/stockChart";
import type { Playbook } from "@/lib/scoring/rpsPlaybooks";
import { Badge, Group, SegmentedControl, Stack, Text } from "@mantine/core";
import {
  CandlestickSeries,
  HistogramSeries,
  LineSeries,
  createChart,
  type IChartApi,
  type Time,
} from "lightweight-charts";
import { useEffect, useRef } from "react";

const COLORS = {
  bg: "#09090b",
  grid: "#27272a",
  text: "#a1a1aa",
  up: "#10b981",
  down: "#ef4444",
  sma20: "#f59e0b",
  sma50: "#a855f7",
  sma120: "#38bdf8",
  sma250: "#94a3b8",
  pullbackBand: "rgba(245, 158, 11, 0.55)",
  climaxCap: "#3b82f6",
  accelOk: "#22c55e",
};

const INTERVAL_LABEL: Record<ChartInterval, string> = {
  "1d": "日线",
  "4h": "4小时",
  "1h": "1小时",
};

function playbookHint(playbook: Playbook | null | undefined, stacked: boolean): string {
  if (playbook === "PULLBACK") {
    return "塌陷法：橙色 SMA20 = 短线冷却上沿，紫色 SMA50 = 中期护盘；价格宜落在 SMA20↓ 与 SMA50↑ 之间的洗盘带。";
  }
  if (playbook === "CLIMAX_FILTER") {
    return "封印法：拒绝抛物线狂热。蓝色虚线 = 最新收盘；关注价格贴着 SMA20/50/120 稳健爬升，而非远离均线暴冲。";
  }
  if (playbook === "EARLY_ACCELERATION") {
    return stacked
      ? "加速法：均线已多头排列 SMA20>50>120>250（结构共振）。"
      : "加速法：寻找短线带领长线；理想结构为 SMA20>SMA50>SMA120>SMA250。";
  }
  return "辅助线为 RPS 窗口对应的 SMA20/50/120/250（价格结构代理，不是 RPS 分位本身）。";
}

export function ScreenerPriceChart({
  data,
  interval,
  onIntervalChange,
}: {
  data: StockChartData;
  interval: ChartInterval;
  onIntervalChange: (interval: ChartInterval) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const playbook = data.playbook ?? null;
  const mas = data.latestMas;

  useEffect(() => {
    if (!containerRef.current) return;
    const latest = data.latestMas;

    const chart = createChart(containerRef.current, {
      autoSize: true,
      layout: {
        background: { color: COLORS.bg },
        textColor: COLORS.text,
        fontFamily: "ui-sans-serif, system-ui, sans-serif",
      },
      grid: {
        vertLines: { color: COLORS.grid },
        horzLines: { color: COLORS.grid },
      },
      timeScale: {
        borderColor: COLORS.grid,
        rightOffset: 5,
        barSpacing: interval === "1d" ? 6 : 4,
        timeVisible: interval !== "1d",
        secondsVisible: false,
      },
      rightPriceScale: {
        borderColor: COLORS.grid,
        scaleMargins: { top: 0.08, bottom: 0.28 },
      },
      crosshair: { mode: 1 },
    });
    chartRef.current = chart;

    const candles = chart.addSeries(CandlestickSeries, {
      upColor: COLORS.up,
      downColor: COLORS.down,
      borderUpColor: COLORS.up,
      borderDownColor: COLORS.down,
      wickUpColor: COLORS.up,
      wickDownColor: COLORS.down,
    });
    candles.setData(
      data.bars.map((b) => ({
        time: b.time as Time,
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
      })),
    );

    const addSma = (
      key: "sma20" | "sma50" | "sma120" | "sma250",
      color: string,
      width: 1 | 2,
    ) => {
      const series = chart.addSeries(LineSeries, {
        color,
        lineWidth: width,
        priceLineVisible: false,
        lastValueVisible: false,
      });
      series.setData(
        data.bars
          .filter((b) => b[key] != null)
          .map((b) => ({ time: b.time as Time, value: b[key] as number })),
      );
    };

    // 加速法加粗短均线；封印法加粗中均线；塌陷法加粗 20/50
    const w20: 1 | 2 = playbook === "EARLY_ACCELERATION" || playbook === "PULLBACK" ? 2 : 1;
    const w50: 1 | 2 = playbook === "PULLBACK" || playbook === "CLIMAX_FILTER" ? 2 : 1;
    const w120: 1 | 2 = playbook === "CLIMAX_FILTER" || playbook === "EARLY_ACCELERATION" ? 2 : 1;
    const w250: 1 | 2 = playbook === "EARLY_ACCELERATION" || playbook === "PULLBACK" ? 2 : 1;

    addSma("sma20", COLORS.sma20, w20);
    addSma("sma50", COLORS.sma50, w50);
    addSma("sma120", COLORS.sma120, w120);
    addSma("sma250", COLORS.sma250, w250);

    const volume = chart.addSeries(HistogramSeries, {
      priceFormat: { type: "volume" },
      priceScaleId: "",
      color: COLORS.grid,
    });
    volume.priceScale().applyOptions({
      scaleMargins: { top: 0.78, bottom: 0 },
    });
    volume.setData(
      data.bars.map((b) => ({
        time: b.time as Time,
        value: b.volume,
        color: b.close >= b.open ? "rgba(16, 185, 129, 0.4)" : "rgba(239, 68, 68, 0.4)",
      })),
    );

    // —— 战法辅助水平线（用最新均线值）——
    if (playbook === "PULLBACK") {
      if (latest.sma20 != null) {
        candles.createPriceLine({
          price: latest.sma20,
          color: COLORS.pullbackBand,
          lineWidth: 1,
          lineStyle: 2,
          axisLabelVisible: true,
          title: `洗盘上沿 SMA20 ${latest.sma20.toFixed(2)}`,
        });
      }
      if (latest.sma50 != null) {
        candles.createPriceLine({
          price: latest.sma50,
          color: COLORS.sma50,
          lineWidth: 1,
          lineStyle: 2,
          axisLabelVisible: true,
          title: `护盘 SMA50 ${latest.sma50.toFixed(2)}`,
        });
      }
    }

    if (playbook === "CLIMAX_FILTER" && latest.close != null) {
      candles.createPriceLine({
        price: latest.close,
        color: COLORS.climaxCap,
        lineWidth: 1,
        lineStyle: 2,
        axisLabelVisible: true,
        title: `现价封印参考 ${latest.close.toFixed(2)}`,
      });
      if (latest.sma20 != null) {
        candles.createPriceLine({
          price: latest.sma20,
          color: COLORS.sma20,
          lineWidth: 1,
          lineStyle: 3,
          axisLabelVisible: true,
          title: `短线锚 SMA20 ${latest.sma20.toFixed(2)}`,
        });
      }
    }

    if (playbook === "EARLY_ACCELERATION") {
      const color = latest.stackedBullish ? COLORS.accelOk : COLORS.sma20;
      if (latest.sma20 != null) {
        candles.createPriceLine({
          price: latest.sma20,
          color,
          lineWidth: 1,
          lineStyle: 0,
          axisLabelVisible: true,
          title: `SMA20 ${latest.sma20.toFixed(2)}`,
        });
      }
      if (latest.sma250 != null) {
        candles.createPriceLine({
          price: latest.sma250,
          color: COLORS.sma250,
          lineWidth: 1,
          lineStyle: 2,
          axisLabelVisible: true,
          title: `底仓 SMA250 ${latest.sma250.toFixed(2)}`,
        });
      }
    }

    chart.timeScale().fitContent();

    return () => {
      chart.remove();
      chartRef.current = null;
    };
  }, [data, interval, playbook]);

  return (
    <Card
      title={`${data.symbol} · ${INTERVAL_LABEL[interval]}`}
      action={
        <Group gap="sm">
          <SegmentedControl
            size="xs"
            value={interval}
            onChange={(v) => onIntervalChange(v as ChartInterval)}
            data={[
              { label: "日线", value: "1d" },
              { label: "4H", value: "4h" },
              { label: "1H", value: "1h" },
            ]}
          />
          {playbook === "EARLY_ACCELERATION" ? (
            <Badge size="sm" color={mas.stackedBullish ? "teal" : "gray"} variant="light">
              {mas.stackedBullish ? "均线多头排列" : "尚未完全排列"}
            </Badge>
          ) : null}
        </Group>
      }
    >
      <Group gap="md" mb="xs" wrap="wrap">
        <Legend color={COLORS.sma20} label="SMA20" />
        <Legend color={COLORS.sma50} label="SMA50" />
        <Legend color={COLORS.sma120} label="SMA120" />
        <Legend color={COLORS.sma250} label="SMA250" />
      </Group>
      <div ref={containerRef} style={{ width: "100%", height: 480 }} />
      <Stack gap={2} mt="sm">
        <Text size="xs" c="dimmed">
          {playbookHint(playbook, mas.stackedBullish)}
        </Text>
        <Text size="xs" c="dimmed">
          说明：图上均线是价格结构代理（对应 RPS 的 20/50/120/250 窗口），RPS 分位本身是全市场相对排名，无法直接画成价格线。
        </Text>
      </Stack>
    </Card>
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <Group gap={6}>
      <div style={{ width: 14, height: 0, borderTop: `2px solid ${color}` }} />
      <Text size="xs" c="dimmed">
        {label}
      </Text>
    </Group>
  );
}
