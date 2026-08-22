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
/** Vegas 隧道：过滤线 + A 组中期成本带 + B 组长期成本带 */
const VEGAS_FILTER = "#52525b";
const VEGAS_A = "#0ea5e9";
const VEGAS_B = "#6366f1";

/**
 * 把一条含空洞的序列切成若干连续持仓段。
 *
 * 不能靠 whitespace（`{ time }` 无值点）来断线：lightweight-charts 的 whitespace
 * 只是占住时间槽，折线渲染时会被跳过，相邻两个有值点仍然直连。空仓期长达数年时
 * 就会拉出一条横跨全图的斜线。每段单独建一条 series 才能真正断开。
 */
function segments(points: { time: string; value: number | null }[]) {
  const out: { time: Time; value: number }[][] = [];
  let cur: { time: Time; value: number }[] = [];
  for (const p of points) {
    if (p.value == null) {
      if (cur.length > 0) out.push(cur);
      cur = [];
    } else {
      cur.push({ time: p.time as Time, value: p.value });
    }
  }
  if (cur.length > 0) out.push(cur);
  return out;
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

    // Vegas 隧道先画，压在防线与 K 线之下。lightweight-charts 没有两线间填充，
    // 因此用同色的两条边界线表达通道，而非 Pine 的 fill() 底色。
    for (const tunnel of [
      { key: "filter" as const, color: VEGAS_FILTER },
      { key: "a1" as const, color: VEGAS_A },
      { key: "a2" as const, color: VEGAS_A },
      { key: "b1" as const, color: VEGAS_B },
      { key: "b2" as const, color: VEGAS_B },
    ]) {
      const points = data.vegas.map((p) => ({ time: p.time, value: p[tunnel.key] }));
      for (const seg of segments(points)) {
        const series = chart.addSeries(LineSeries, {
          color: tunnel.color,
          lineWidth: 1,
          priceLineVisible: false,
          lastValueVisible: false,
          crosshairMarkerVisible: false,
        });
        series.setData(seg);
      }
    }

    // 两个仓位槽各画两条防线：硬止损（红）与移动止损（紫，Pine 里误名为「止盈线」）。
    const lines: { points: { time: string; value: number | null }[]; color: string; dashed: boolean }[] = [
      { points: data.buy1Stops.map((p) => ({ time: p.time, value: p.stop })), color: STOP, dashed: false },
      { points: data.buy1Stops.map((p) => ({ time: p.time, value: p.trail })), color: TRAIL, dashed: false },
      { points: data.buy2Stops.map((p) => ({ time: p.time, value: p.stop })), color: STOP, dashed: true },
      { points: data.buy2Stops.map((p) => ({ time: p.time, value: p.trail })), color: TRAIL, dashed: true },
    ];
    for (const line of lines) {
      for (const seg of segments(line.points)) {
        const series = chart.addSeries(LineSeries, {
          color: line.color,
          lineWidth: 1,
          lineStyle: line.dashed ? LineStyle.Dashed : LineStyle.Solid,
          priceLineVisible: false,
          lastValueVisible: false,
          crosshairMarkerVisible: false,
        });
        series.setData(seg);
      }
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
          <Text size="xs" c="dimmed">移动止损 5.5 → 3.8 → 2.8 ×ATR（跟随最高价上抬）</Text>
        </Group>
        <Group gap={6}>
          <span className="inline-block h-px w-4" style={{ background: VEGAS_A }} />
          <Text size="xs" c="dimmed">Vegas A 组 EMA144/169（中期成本带）</Text>
        </Group>
        <Group gap={6}>
          <span className="inline-block h-px w-4" style={{ background: VEGAS_B }} />
          <Text size="xs" c="dimmed">Vegas B 组 EMA576/676（长期成本带）</Text>
        </Group>
        <Text size="xs" c="dimmed">实线为一买槽，虚线为二买槽</Text>
        <Text size="xs" c="dimmed">跌破两条中任意一条即离场，故生效的是更高的那条</Text>
      </Group>
    </Card>
  );
}
