"use client";

import type { ChartBar, StockChartData } from "@/lib/dashboard/stockChart";
import { Card } from "@/components/Card";
import { Group, Stack, Text } from "@mantine/core";
import {
  CandlestickSeries,
  HistogramSeries,
  LineSeries,
  createChart,
  type IChartApi,
  type ISeriesApi,
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
  goldenZone: "rgba(34, 197, 94, 0.6)",
  stop: "#ef4444",
  fair: "#3b82f6", // 长期公允价 PWFV
  target60d: "#22d3ee", // 60D 波段目标价 Trading Target
};

export function PriceChart({
  data,
  tradingTarget60d,
}: {
  data: StockChartData;
  tradingTarget60d?: number | null;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;

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
        barSpacing: 6,
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
      data.bars.map((b: ChartBar) => ({
        time: b.time as Time,
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
      })),
    );

    const sma20 = chart.addSeries(LineSeries, {
      color: COLORS.sma20,
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: false,
    });
    sma20.setData(
      data.bars
        .filter((b) => b.sma20 != null)
        .map((b) => ({ time: b.time as Time, value: b.sma20 as number })),
    );

    const sma50 = chart.addSeries(LineSeries, {
      color: COLORS.sma50,
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: false,
    });
    sma50.setData(
      data.bars
        .filter((b) => b.sma50 != null)
        .map((b) => ({ time: b.time as Time, value: b.sma50 as number })),
    );

    // Volume 副图（分开的 pane，v5 用 paneIndex）
    const volume: ISeriesApi<"Histogram"> = chart.addSeries(
      HistogramSeries,
      {
        priceFormat: { type: "volume" },
        priceScaleId: "",
        color: COLORS.grid,
      },
    );
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

    // Execution 价位标线：Golden Buy Zone 上/下轨 + 动态止损 + 加权公允价
    const exec = data.execution;
    if (exec) {
      candles.createPriceLine({
        price: exec.goldenBuyHigh,
        color: COLORS.goldenZone,
        lineWidth: 1,
        lineStyle: 2, // dashed
        axisLabelVisible: true,
        title: `Golden ${exec.goldenBuyHigh.toFixed(2)}`,
      });
      candles.createPriceLine({
        price: exec.goldenBuyLow,
        color: COLORS.goldenZone,
        lineWidth: 1,
        lineStyle: 2,
        axisLabelVisible: true,
        title: `Buy Zone ${exec.goldenBuyLow.toFixed(2)}`,
      });
      candles.createPriceLine({
        price: exec.stopLoss,
        color: COLORS.stop,
        lineWidth: 1,
        lineStyle: 0, // solid
        axisLabelVisible: true,
        title: `Stop ${exec.stopLoss.toFixed(2)}`,
      });
      candles.createPriceLine({
        price: exec.valuation.weightedFair,
        color: COLORS.fair,
        lineWidth: 1,
        lineStyle: 3, // dotted
        axisLabelVisible: true,
        title: `PWFV ${exec.valuation.weightedFair.toFixed(2)}`,
      });
    }

    // v3 Dual-Target: 60D Trading Target（独立于 PWFV 的短期波段目标）
    if (tradingTarget60d != null && tradingTarget60d > 0) {
      candles.createPriceLine({
        price: tradingTarget60d,
        color: COLORS.target60d,
        lineWidth: 1,
        lineStyle: 2, // dashed
        axisLabelVisible: true,
        title: `60D Target ${tradingTarget60d.toFixed(2)}`,
      });
    }

    chart.timeScale().fitContent();

    return () => {
      chart.remove();
      chartRef.current = null;
    };
  }, [data, tradingTarget60d]);

  const exec = data.execution;

  return (
    <Card
      title={`${data.symbol} · TradingView Chart`}
      action={
        <Group gap="md">
          <Legend swatchColor={COLORS.sma20} label="SMA20" />
          <Legend swatchColor={COLORS.sma50} label="SMA50" />
          {exec ? (
            <>
              <Legend swatchColor={COLORS.goldenZone} label="Golden Buy Zone" dashed />
              <Legend swatchColor={COLORS.stop} label="止损 2×ATR" />
              <Legend swatchColor={COLORS.fair} label="PWFV 6-12M" dotted />
            </>
          ) : null}
          {tradingTarget60d != null && tradingTarget60d > 0 ? (
            <Legend swatchColor={COLORS.target60d} label="60D Target" dashed />
          ) : null}
        </Group>
      }
    >
      <div ref={containerRef} style={{ width: "100%", height: 460 }} />
      {exec ? (
        <Stack gap={2} mt="sm">
          <Text size="xs" c="dimmed">
            💡 <b>Dual-Target 双价格解耦</b>：<span style={{ color: COLORS.fair }}>PWFV 6-12M</span>（长期公允价，是否值得持有） vs
            <span style={{ color: COLORS.target60d }}> 60D Target</span>（短期波段空间）。Golden Buy Zone = SMA20/50/TWAP20 中枢 ±1.2%；止损 = 收盘 − 2×ATR14。
          </Text>
        </Stack>
      ) : (
        <Text size="xs" c="dimmed" mt="sm">
          该股不在 Top 100，暂无执行计划标线（仅显示行情）
        </Text>
      )}
    </Card>
  );
}

function Legend({
  swatchColor,
  label,
  dashed,
  dotted,
}: {
  swatchColor: string;
  label: string;
  dashed?: boolean;
  dotted?: boolean;
}) {
  const border = dashed ? "1px dashed" : dotted ? "1px dotted" : "1px solid";
  return (
    <Group gap={6}>
      <div
        style={{
          width: 14,
          height: 0,
          borderTop: `${border} ${swatchColor}`,
        }}
      />
      <Text size="xs" c="dimmed">
        {label}
      </Text>
    </Group>
  );
}
