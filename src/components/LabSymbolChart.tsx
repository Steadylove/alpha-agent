"use client";

import { segments } from "@/lib/charts/segments";
import { Badge, Button, Group, Loader, Modal, Stack, Table, Text } from "@mantine/core";
import {
  CandlestickSeries,
  LineSeries,
  LineStyle,
  createChart,
  createSeriesMarkers,
  type IChartApi,
  type ISeriesMarkersPluginApi,
  type SeriesMarker,
  type Time,
} from "lightweight-charts";
import { useEffect, useRef, useState } from "react";

const UP = "#089981";
const DOWN = "#f23645";
const STOP = "#f23645";
const TRAIL = "#a855f7";
const TARGET = "#14b8a6";
const BUY1 = "#ff4976";
const BUY2 = "#fbbf24";

/** 聚焦单笔时前后各留的交易日，用来看清入场前的形态与离场后的走势。 */
const PAD_BEFORE = 70;
const PAD_AFTER = 45;

type Trade = {
  entryDate: string;
  entryPrice: number;
  exitDate: string;
  exitPrice: number;
  pnlPct: number;
  barsHeld: number;
  exitReason: string;
  sigType: 1 | 2;
  r: number;
  isOutOfSample: boolean;
};

type ChartData = {
  symbol: string;
  splitDate: string;
  bars: { time: string[]; open: number[]; high: number[]; low: number[]; close: number[] };
  levels: { stop: (number | null)[]; trail: (number | null)[]; target: (number | null)[] };
  trades: Trade[];
};

/** 点开的是哪只标的的哪一笔。带上日期才能把视野收到那一笔上。 */
export type ChartTarget = { symbol: string; entryDate: string };

const pct = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;

const EXIT_TEXT: Record<string, string> = {
  stop: "吊灯",
  target: "止盈",
  rsWeak: "转弱",
  veto: "否决",
};

/**
 * 单只标的的 K 线弹窗：画出本次回测在它身上的进出场点与风控线。
 *
 * 数据来自 /api/lab/chart，那个接口和回测共用 `runSymbol`，所以图上的每个
 * 箭头都对应逐笔表里的一行——不是另算一遍的近似值。
 */
export function LabSymbolChart({
  target,
  request,
  onClose,
}: {
  target: ChartTarget | null;
  /**
   * 当前生效的参数与标的池，原样转给接口，保证与逐笔表同一组配置。
   * 必须是稳定引用（父组件 useMemo），否则每次渲染都会重新取数。
   */
  request: Record<string, unknown>;
  onClose: () => void;
}) {
  /**
   * 结果带上它对应的 symbol，而不是在标的变化时先把 data 置空。
   * 置空要在 effect 里同步 setState，会多跑一轮渲染；带标签则可以直接比对新鲜度。
   */
  const [fetched, setFetched] = useState<{
    symbol: string;
    data: ChartData | null;
    error: string | null;
  } | null>(null);
  /** 在弹窗里改看别的一笔。同样带 symbol 标签，换标的时自动失效。 */
  const [picked, setPicked] = useState<ChartTarget | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const markersRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);

  const symbol = target?.symbol ?? null;

  useEffect(() => {
    if (!symbol) return;
    let alive = true;
    void (async () => {
      try {
        const res = await fetch("/api/lab/chart", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...request, symbol }),
        });
        const json = await res.json();
        if (!alive) return;
        if (!res.ok) throw new Error(json.error ?? "取图表数据失败");
        setFetched({ symbol, data: json as ChartData, error: null });
      } catch (e) {
        if (alive) {
          setFetched({
            symbol,
            data: null,
            error: e instanceof Error ? e.message : "取图表数据失败",
          });
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [symbol, request]);

  // 只认当前标的的结果，旧标的的数据一律当作还没到
  const current = fetched?.symbol === symbol ? fetched : null;
  const data = current?.data ?? null;
  const error = current?.error ?? null;

  /**
   * 放大到哪一笔，空串为全期视野。
   *
   * 打开时一律给全期：先看清这只票二十年的位置，要看细节再点。
   * 从逐笔表点进来的那一笔只做高亮（见 anchorIdx），不自动放大。
   */
  const focus = picked?.symbol === symbol ? picked.entryDate : "";

  const idxOf = (entryDate: string) =>
    data && entryDate ? data.trades.findIndex((t) => t.entryDate === entryDate) : -1;
  const focusIdx = idxOf(focus);
  /** 从逐笔表点进来的那一笔，全期视野下也要让它在表里可辨。 */
  const anchorIdx = idxOf(target?.entryDate ?? "");
  const currentIdx = focusIdx >= 0 ? focusIdx : anchorIdx;

  useEffect(() => {
    if (!data || !containerRef.current) return;

    const chart = createChart(containerRef.current, {
      layout: { background: { color: "transparent" }, textColor: "#a1a1aa", fontSize: 11 },
      grid: { vertLines: { color: "#27272a" }, horzLines: { color: "#27272a" } },
      rightPriceScale: { borderColor: "#3f3f46", scaleMargins: { top: 0.12, bottom: 0.12 } },
      // minBarSpacing 默认 0.5px，二十年 5000 根要 0.17px/根，不放开的话
      // fitContent 会被静默夹住，只显示最近十年——看着像全期，其实不是。
      timeScale: { borderColor: "#3f3f46", rightOffset: 4, minBarSpacing: 0.05 },
      crosshair: { mode: 0 },
      autoSize: true,
    });
    chartRef.current = chart;

    const { time, open, high, low, close } = data.bars;
    const candles = chart.addSeries(CandlestickSeries, {
      upColor: UP,
      downColor: DOWN,
      borderUpColor: UP,
      borderDownColor: DOWN,
      wickUpColor: UP,
      wickDownColor: DOWN,
    });
    candles.setData(
      time.map((t, i) => ({
        time: t as Time,
        open: open[i],
        high: high[i],
        low: low[i],
        close: close[i],
      })),
    );

    for (const line of [
      { values: data.levels.stop, color: STOP, dashed: false },
      { values: data.levels.trail, color: TRAIL, dashed: false },
      { values: data.levels.target, color: TARGET, dashed: true },
    ]) {
      const points = time.map((t, i) => ({ time: t, value: line.values[i] }));
      for (const seg of segments(points)) {
        chart
          .addSeries(LineSeries, {
            color: line.color,
            lineWidth: 2,
            lineStyle: line.dashed ? LineStyle.Dashed : LineStyle.Solid,
            priceLineVisible: false,
            lastValueVisible: false,
            crosshairMarkerVisible: false,
          })
          .setData(seg);
      }
    }

    markersRef.current = createSeriesMarkers(candles, []);

    return () => {
      chart.remove();
      chartRef.current = null;
      markersRef.current = null;
    };
  }, [data]);

  // 标记单独一个 effect：只有当前那一笔带文字，二十年全期下十几个标签会糊成一片
  useEffect(() => {
    const plugin = markersRef.current;
    if (!plugin || !data) return;
    const markers: SeriesMarker<Time>[] = [];
    data.trades.forEach((t, i) => {
      const labelled = i === currentIdx;
      markers.push({
        time: t.entryDate as Time,
        position: "belowBar",
        shape: "arrowUp",
        color: t.sigType === 1 ? BUY1 : BUY2,
        text: labelled ? `${t.sigType === 1 ? "一买" : "二买"} ${t.entryPrice.toFixed(2)}` : "",
      });
      markers.push({
        time: t.exitDate as Time,
        position: "aboveBar",
        shape: "arrowDown",
        color: t.pnlPct >= 0 ? UP : DOWN,
        text: labelled ? `${EXIT_TEXT[t.exitReason] ?? t.exitReason} ${pct(t.pnlPct)}` : "",
      });
    });
    // 时间必须升序，否则 lightweight-charts 会静默丢点
    markers.sort((a, b) => String(a.time).localeCompare(String(b.time)));
    plugin.setMarkers(markers);
  }, [data, currentIdx]);

  // 视野单独一个 effect：切换看哪一笔时不该重建整张图
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || !data) return;
    const { time } = data.bars;
    const trade = focusIdx >= 0 ? data.trades[focusIdx] : null;
    if (!trade) {
      chart.timeScale().fitContent();
      return;
    }
    const lo = Math.max(0, time.indexOf(trade.entryDate) - PAD_BEFORE);
    const hi = Math.min(time.length - 1, time.indexOf(trade.exitDate) + PAD_AFTER);
    chart.timeScale().setVisibleRange({ from: time[lo] as Time, to: time[hi] as Time });
  }, [data, focusIdx]);

  const step = (delta: number) => {
    if (!data || !symbol) return;
    // 全期视野下以点进来的那一笔为基点，翻页才有着落
    const next = data.trades[(currentIdx < 0 ? 0 : currentIdx) + delta];
    if (next) setPicked({ symbol, entryDate: next.entryDate });
  };

  return (
    <Modal
      opened={target != null}
      onClose={onClose}
      size="88rem"
      title={
        <Group gap="sm">
          <Text fw={700}>{symbol}</Text>
          {data ? (
            <Text size="xs" c="dimmed" ff="monospace">
              本次回测成交 {data.trades.length} 笔 · 全期 {data.bars.time.length} 根日线
            </Text>
          ) : null}
        </Group>
      }
    >
      {error ? (
        <Text size="sm" c="red.4">
          {error}
        </Text>
      ) : !data ? (
        <Group gap="sm" py="xl" justify="center">
          <Loader size="sm" color="gray" />
          <Text size="sm" c="dimmed">
            正在按当前参数重算这只标的…
          </Text>
        </Group>
      ) : (
        <Stack gap="sm">
          <Group gap="xs">
            <Button
              size="compact-xs"
              variant="default"
              disabled={currentIdx <= 0}
              onClick={() => step(-1)}
            >
              上一笔
            </Button>
            <Button
              size="compact-xs"
              variant="default"
              disabled={currentIdx < 0 || currentIdx >= data.trades.length - 1}
              onClick={() => step(1)}
            >
              下一笔
            </Button>
            {currentIdx >= 0 ? (
              <Button
                size="compact-xs"
                variant="default"
                disabled={focusIdx >= 0}
                onClick={() =>
                  symbol && setPicked({ symbol, entryDate: data.trades[currentIdx].entryDate })
                }
              >
                放大这一笔
              </Button>
            ) : null}
            <Button
              size="compact-xs"
              variant={focusIdx < 0 ? "light" : "subtle"}
              color="gray"
              disabled={focusIdx < 0}
              onClick={() => symbol && setPicked({ symbol, entryDate: "" })}
            >
              看全期
            </Button>
            <Text size="xs" c="dimmed">
              {focusIdx >= 0
                ? `第 ${focusIdx + 1} / ${data.trades.length} 笔，前后各留约 ${PAD_BEFORE}/${PAD_AFTER} 根`
                : "全期 20 年视野。单笔持仓只有几根，风控线要放大才看得见——点表格任一行即可"}
            </Text>
          </Group>

          <div ref={containerRef} style={{ height: 430 }} />

          <Group gap="lg" wrap="wrap">
            <Legend color={STOP} text="初始止损 stopMult×ATR（持仓期恒定）" />
            <Legend color={TRAIL} text="吊灯止损（跟随最高价上抬，浮盈越高收得越紧）" />
            <Legend color={TARGET} text="R 倍数止盈（未开启时不画）" dashed />
            <Text size="xs" c="dimmed">
              箭头落在<b>成交那一根</b>：信号在前一根收盘确认，次日开盘才成交
            </Text>
          </Group>

          {data.trades.length > 0 ? (
            <Table fz="xs" verticalSpacing={4} highlightOnHover>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>入场</Table.Th>
                  <Table.Th ta="right">入场价</Table.Th>
                  <Table.Th>离场</Table.Th>
                  <Table.Th ta="right">离场价</Table.Th>
                  <Table.Th ta="right">持仓</Table.Th>
                  <Table.Th>离场原因</Table.Th>
                  <Table.Th ta="right">收益</Table.Th>
                  <Table.Th ta="right">R</Table.Th>
                  <Table.Th>窗口</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {data.trades.map((t, i) => (
                  <Table.Tr
                    key={`${t.entryDate}-${t.exitDate}`}
                    onClick={() => symbol && setPicked({ symbol, entryDate: t.entryDate })}
                    style={{
                      cursor: "pointer",
                      background: i === currentIdx ? "rgba(255,255,255,0.06)" : undefined,
                    }}
                  >
                    <Table.Td ff="monospace">{t.entryDate}</Table.Td>
                    <Table.Td ta="right" ff="monospace">
                      {t.entryPrice.toFixed(2)}
                    </Table.Td>
                    <Table.Td ff="monospace">{t.exitDate}</Table.Td>
                    <Table.Td ta="right" ff="monospace">
                      {t.exitPrice.toFixed(2)}
                    </Table.Td>
                    <Table.Td ta="right" ff="monospace" c="dimmed">
                      {t.barsHeld} 根
                    </Table.Td>
                    <Table.Td c="dimmed">{EXIT_TEXT[t.exitReason] ?? t.exitReason}</Table.Td>
                    <Table.Td
                      ta="right"
                      ff="monospace"
                      style={{ color: t.pnlPct >= 0 ? UP : DOWN }}
                    >
                      {pct(t.pnlPct)}
                    </Table.Td>
                    <Table.Td ta="right" ff="monospace" style={{ color: t.r >= 0 ? UP : DOWN }}>
                      {t.r >= 0 ? "+" : ""}
                      {t.r.toFixed(2)}
                    </Table.Td>
                    <Table.Td>
                      <Badge size="xs" variant="light" color={t.isOutOfSample ? "gray" : "blue"}>
                        {t.isOutOfSample ? "保留区" : "训练区"}
                      </Badge>
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          ) : (
            <Text size="xs" c="dimmed">
              当前参数下这只标的没有成交。
            </Text>
          )}
        </Stack>
      )}
    </Modal>
  );
}

function Legend({ color, text, dashed }: { color: string; text: string; dashed?: boolean }) {
  return (
    <Group gap={6}>
      <span
        className="inline-block h-0.5 w-4"
        style={
          dashed
            ? {
                backgroundImage: `linear-gradient(90deg, ${color} 60%, transparent 60%)`,
                backgroundSize: "5px 2px",
              }
            : { background: color }
        }
      />
      <Text size="xs" c="dimmed">
        {text}
      </Text>
    </Group>
  );
}
