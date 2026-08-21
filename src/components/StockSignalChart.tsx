"use client";

import { Card } from "@/components/Card";
import type { StockSignalChartData } from "@/lib/dashboard/stockSignalChart";
import { Group, Stack, Text } from "@mantine/core";
import {
  CandlestickSeries,
  HistogramSeries,
  LineSeries,
  LineStyle,
  createChart,
  createSeriesMarkers,
  type IChartApi,
  type SeriesMarker,
  type Time,
} from "lightweight-charts";
import { useEffect, useRef } from "react";

const UP = "#089981";
const DOWN = "#f23645";
const BUY1 = "#ff4976";
const BUY2 = "#fbbf24";
const STOP = "#f23645";
const TRAIL = "#a855f7";

/** 止损线只在持仓期间存在，用 whitespace 断开而不是连成一条横跨空仓期的直线。 */
function stepData(points: { time: string; value: number | null }[]) {
  return points.map((p) => (p.value == null ? { time: p.time as Time } : { time: p.time as Time, value: p.value }));
}

export function StockSignalChart({ data }: { data: StockSignalChartData }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    const chart = createChart(containerRef.current, {
      layout: {
        background: { color: "transparent" },
        textColor: "#a1a1aa",
        fontSize: 11,
      },
      grid: {
        vertLines: { color: "#27272a" },
        horzLines: { color: "#27272a" },
      },
      rightPriceScale: { borderColor: "#3f3f46", scaleMargins: { top: 0.08, bottom: 0.26 } },
      timeScale: { borderColor: "#3f3f46", rightOffset: 6 },
      crosshair: { mode: 0 },
      autoSize: true,
    });
    chartRef.current = chart;

    const candles = chart.addSeries(CandlestickSeries, {
      upColor: UP,
      downColor: DOWN,
      borderUpColor: UP,
      borderDownColor: DOWN,
      wickUpColor: UP,
      wickDownColor: DOWN,
    });
    candles.setData(
      data.candles.map((c) => ({
        time: c.time as Time,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
      })),
    );

    const volume = chart.addSeries(HistogramSeries, {
      priceFormat: { type: "volume" },
      priceScaleId: "vol",
      priceLineVisible: false,
      lastValueVisible: false,
    });
    chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    volume.setData(
      data.candles.map((c) => ({
        time: c.time as Time,
        value: c.volume,
        color: c.close >= c.open ? `${UP}55` : `${DOWN}55`,
      })),
    );

    // 两个仓位槽各画两条防线：硬止损（红）与移动止盈（紫）。
    const lines: { points: { time: string; value: number | null }[]; color: string; dashed: boolean }[] = [
      { points: data.buy1Stops.map((p) => ({ time: p.time, value: p.stop })), color: STOP, dashed: false },
      { points: data.buy1Stops.map((p) => ({ time: p.time, value: p.trail })), color: TRAIL, dashed: false },
      { points: data.buy2Stops.map((p) => ({ time: p.time, value: p.stop })), color: STOP, dashed: true },
      { points: data.buy2Stops.map((p) => ({ time: p.time, value: p.trail })), color: TRAIL, dashed: true },
    ];
    for (const line of lines) {
      if (line.points.every((p) => p.value == null)) continue;
      const series = chart.addSeries(LineSeries, {
        color: line.color,
        lineWidth: 1,
        lineStyle: line.dashed ? LineStyle.Dashed : LineStyle.Solid,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
      });
      series.setData(stepData(line.points));
    }

    const markers: SeriesMarker<Time>[] = data.markers.map((m) => {
      if (m.kind === "exit") {
        return {
          time: m.time as Time,
          position: "aboveBar" as const,
          shape: "arrowDown" as const,
          color: (m.pnlPct ?? 0) >= 0 ? UP : DOWN,
          text: `${m.slot === "buy1" ? "一" : "二"}买离场 ${(m.pnlPct ?? 0) >= 0 ? "+" : ""}${(m.pnlPct ?? 0).toFixed(0)}%`,
        };
      }
      const isBuy1 = m.kind === "buy1";
      return {
        time: m.time as Time,
        position: "belowBar" as const,
        shape: "arrowUp" as const,
        color: m.blocked ? "#52525b" : isBuy1 ? BUY1 : BUY2,
        text: m.blocked
          ? `${isBuy1 ? "一" : "二"}买(RSI阻断)`
          : isBuy1
            ? "❤️ 一买"
            : "⭐️ 二买",
      };
    });
    createSeriesMarkers(candles, markers);

    chart.timeScale().fitContent();

    return () => {
      chart.remove();
      chartRef.current = null;
    };
  }, [data]);

  return (
    <Card
      title={
        <Stack gap={2}>
          <Text size="sm" fw={700} c="gray.1">
            {data.symbol} · 买卖点与风控线
          </Text>
          <Text size="xs" c="dimmed">
            近 {data.windowDays} 根日线（信号在全部 {data.totalBars} 根上推进后截取）
          </Text>
        </Stack>
      }
    >
      <div ref={containerRef} style={{ height: 460 }} />

      <Group gap="lg" mt="sm" wrap="wrap">
        <Group gap={6}>
          <span className="inline-block h-2 w-2 rotate-45" style={{ background: BUY1 }} />
          <Text size="xs" c="dimmed">❤️ 一买点火</Text>
        </Group>
        <Group gap={6}>
          <span className="inline-block h-2 w-2 rotate-45" style={{ background: BUY2 }} />
          <Text size="xs" c="dimmed">⭐️ 二买点火</Text>
        </Group>
        <Group gap={6}>
          <span className="inline-block h-2 w-2 rotate-45 bg-zinc-600" />
          <Text size="xs" c="dimmed">信号成型但 RSI 闸门拦下</Text>
        </Group>
        <Group gap={6}>
          <span className="inline-block h-px w-4" style={{ background: STOP }} />
          <Text size="xs" c="dimmed">硬止损 4×ATR（触发保本后上移至成本 ×1.01）</Text>
        </Group>
        <Group gap={6}>
          <span className="inline-block h-px w-4" style={{ background: TRAIL }} />
          <Text size="xs" c="dimmed">移动止盈 5.5 → 3.8 → 2.8 ×ATR</Text>
        </Group>
        <Text size="xs" c="dimmed">实线为一买槽，虚线为二买槽</Text>
      </Group>
    </Card>
  );
}
