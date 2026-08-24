"use client";

import { useMemo, useState } from "react";
import { Badge, Group, SegmentedControl, Stack, Table, Text } from "@mantine/core";
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { Card } from "@/components/Card";
import type { DayBook, HoldingDay, YearToDate } from "@/lib/backtest/engine";

const POS = "#089981";
const NEG = "#f23645";
const BENCH = "#71717a";
const SPY = "#d97706";

const pct = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`;
const tone = (v: number) => (v >= 0 ? POS : NEG);

type TradeLite = {
  symbol: string;
  sigType: 1 | 2;
  entryDate: string;
  exitDate: string;
  pnlPct: number;
};

type ChartRow = DayBook & { spy: number | null };

export function LabFundChart({
  book,
  holdings,
  ytd,
  trades,
  splitDate,
  maskAfterSplit,
  onPick,
}: {
  book: DayBook[];
  holdings: HoldingDay[];
  ytd: YearToDate | null;
  trades: TradeLite[];
  splitDate: string;
  maskAfterSplit: boolean;
  onPick: (symbol: string, entryDate: string) => void;
}) {
  const ytdVisible = Boolean(ytd && (!maskAfterSplit || ytd.from < splitDate));
  const [range, setRange] = useState<"all" | "ytd">(ytdVisible ? "ytd" : "all");
  const [picked, setPicked] = useState<string | null>(null);
  const view = range === "ytd" && ytdVisible ? "ytd" : "all";

  const holdMap = useMemo(() => {
    const m = new Map<string, HoldingDay["rows"]>();
    for (const h of holdings) m.set(h.date, h.rows);
    return m;
  }, [holdings]);

  const shown = useMemo((): ChartRow[] => {
    const src = maskAfterSplit ? book.filter((p) => p.date < splitDate) : book;
    if (view !== "ytd" || !ytd) return src.map((p) => ({ ...p }));
    const first = src.findIndex((p) => p.date >= ytd.from);
    if (first < 0) return src.map((p) => ({ ...p }));
    const prevS = first > 0 ? src[first - 1].strategy : 1;
    const prevB = first > 0 ? src[first - 1].benchmark : 1;
    const prevSpy = first > 0 ? (src[first - 1].spy ?? 1) : 1;
    return src.slice(first).map((p) => ({
      ...p,
      strategy: p.strategy / prevS,
      benchmark: p.benchmark / prevB,
      spy: p.spy == null ? null : p.spy / prevSpy,
    }));
  }, [book, maskAfterSplit, splitDate, view, ytd]);

  const last = shown[shown.length - 1];
  const selectedDate = picked && shown.some((p) => p.date === picked) ? picked : (last?.date ?? null);
  const selected = shown.find((p) => p.date === selectedDate) ?? null;
  const selectedRows = selectedDate ? (holdMap.get(selectedDate) ?? []) : [];
  const hasSpy = shown.some((p) => p.spy != null);

  const dayTrades = useMemo(() => {
    if (!selectedDate) return [];
    return trades.filter((t) => t.entryDate === selectedDate || t.exitDate === selectedDate);
  }, [trades, selectedDate]);

  return (
    <Stack gap="sm">
      <Card
        title={
          <Group justify="space-between" align="flex-start" wrap="nowrap">
            <Stack gap={4}>
              <Text size="sm" fw={700} c="gray.1">
                净值
              </Text>
              {ytd && view === "ytd" ? (
                <Group gap="md">
                  <InlineStat label="策略" value={pct(ytd.strategyPct)} color={tone(ytd.strategyPct)} />
                  <InlineStat label="同池" value={pct(ytd.benchmarkPct)} color={BENCH} />
                  {ytd.spyPct != null ? (
                    <InlineStat label="标普" value={pct(ytd.spyPct)} color={SPY} />
                  ) : null}
                </Group>
              ) : (
                <Text size="xs" c="dimmed">
                  绿策略 · 灰同池等权{hasSpy ? " · 琥珀标普" : ""}
                </Text>
              )}
            </Stack>
            <SegmentedControl
              size="xs"
              value={view}
              onChange={(v) => setRange(v as "all" | "ytd")}
              data={[
                { label: "全期", value: "all" },
                { label: ytd ? `${ytd.year}` : "YTD", value: "ytd", disabled: !ytdVisible },
              ]}
            />
          </Group>
        }
      >
        <div style={{ height: 280 }}>
          <ResponsiveContainer width="100%" height="100%">
            <LineChart
              data={shown}
              margin={{ top: 8, right: 8, bottom: 0, left: -8 }}
              onClick={(state) => {
                const d = (state as { activeLabel?: string } | null)?.activeLabel;
                if (d) setPicked(d);
              }}
            >
              <CartesianGrid stroke="#27272a" vertical={false} />
              <XAxis
                dataKey="date"
                tick={{ fill: "#71717a", fontSize: 11 }}
                tickLine={false}
                axisLine={{ stroke: "#27272a" }}
                minTickGap={56}
                tickFormatter={(d: string) => d.slice(0, 7)}
              />
              <YAxis
                scale={view === "all" ? "log" : "auto"}
                domain={["auto", "auto"]}
                tick={{ fill: "#71717a", fontSize: 11 }}
                tickLine={false}
                axisLine={false}
                width={52}
                tickFormatter={(v: number) => `${v.toFixed(view === "all" ? 1 : 2)}x`}
              />
              <ReferenceLine y={1} stroke="#3f3f46" />
              {selectedDate ? (
                <ReferenceLine x={selectedDate} stroke="#a1a1aa" strokeDasharray="3 3" />
              ) : null}
              <Tooltip content={<FundTooltip range={view} />} cursor={{ stroke: "#52525b" }} isAnimationActive={false} />
              <Line type="monotone" dataKey="benchmark" stroke={BENCH} strokeWidth={1.25} dot={false} isAnimationActive={false} />
              {hasSpy ? (
                <Line type="monotone" dataKey="spy" stroke={SPY} strokeWidth={1.25} dot={false} isAnimationActive={false} connectNulls />
              ) : null}
              <Line type="monotone" dataKey="strategy" stroke={POS} strokeWidth={1.75} dot={false} isAnimationActive={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </Card>

      <Card
        title={
          <Group justify="space-between">
            <Text size="sm" fw={700} c="gray.1">
              {selectedDate ?? "—"}
            </Text>
            {selected ? (
              <Text size="xs" c="dimmed" ff="monospace">
                {selected.nHold} 只 · 策略 {selected.strategy.toFixed(2)}x
                {selected.spy != null ? ` · 标普 ${selected.spy.toFixed(2)}x` : ""}
              </Text>
            ) : null}
          </Group>
        }
      >
        {selected?.buys.length || selected?.sells.length ? (
          <Group gap="xs" mb="sm">
            {(selected?.buys ?? []).map((s) => (
              <Badge key={`b-${s}`} size="sm" color="teal" variant="light">
                买 {s}
              </Badge>
            ))}
            {(selected?.sells ?? []).map((s) => (
              <Badge key={`s-${s}`} size="sm" color="red" variant="light">
                卖 {s}
              </Badge>
            ))}
          </Group>
        ) : null}

        {selectedRows.length === 0 ? (
          <Text size="sm" c="dimmed">
            空仓
          </Text>
        ) : (
          <Table verticalSpacing={4} fz="xs" highlightOnHover>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>标的</Table.Th>
                <Table.Th ta="right">权重</Table.Th>
                <Table.Th ta="right">浮盈</Table.Th>
                <Table.Th ta="right">RPS</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {selectedRows.map((row) => (
                <Table.Tr
                  key={row.symbol}
                  className="cursor-pointer"
                  onClick={() => onPick(row.symbol, row.entryDate ?? selectedDate ?? "")}
                >
                  <Table.Td ff="monospace">{row.symbol}</Table.Td>
                  <Table.Td ta="right" ff="monospace">
                    {row.weightPct.toFixed(0)}%
                  </Table.Td>
                  <Table.Td ta="right" ff="monospace" style={{ color: tone(row.floatPnlPct) }}>
                    {pct(row.floatPnlPct)}
                  </Table.Td>
                  <Table.Td ta="right" ff="monospace" c="dimmed">
                    {row.entryRps == null ? "—" : row.entryRps.toFixed(0)}
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        )}

        {dayTrades.length > 0 ? (
          <div className="mt-3 border-t border-[var(--border-subtle)] pt-2">
            {dayTrades.map((t) => (
              <button
                key={`${t.symbol}-${t.entryDate}`}
                type="button"
                className="flex w-full justify-between py-1 font-mono text-xs text-zinc-400 hover:text-zinc-200"
                onClick={() => onPick(t.symbol, t.entryDate)}
              >
                <span>
                  {t.exitDate === selectedDate ? "卖" : "买"} {t.symbol}
                </span>
                <span style={{ color: t.exitDate === selectedDate ? tone(t.pnlPct) : undefined }}>
                  {t.exitDate === selectedDate ? pct(t.pnlPct) : t.entryDate}
                </span>
              </button>
            ))}
          </div>
        ) : null}
      </Card>
    </Stack>
  );
}

function InlineStat({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <Text size="xs" c="dimmed">
      {label}{" "}
      <span className="font-mono" style={{ color }}>
        {value}
      </span>
    </Text>
  );
}

function FundTooltip({
  active,
  payload,
  range,
}: {
  active?: boolean;
  payload?: { payload: ChartRow }[];
  range: "all" | "ytd";
}) {
  const p = payload?.[0]?.payload;
  if (!active || !p) return null;
  const digits = range === "all" ? 2 : 3;
  return (
    <div className="rounded border border-[var(--border-strong)] bg-[var(--surface-hover)]/95 px-3 py-2 text-xs">
      <div className="font-mono text-zinc-400">{p.date}</div>
      <div className="mt-1 font-mono" style={{ color: POS }}>
        策略 {p.strategy.toFixed(digits)}x
      </div>
      <div className="font-mono text-zinc-400">同池 {p.benchmark.toFixed(digits)}x</div>
      {p.spy != null ? (
        <div className="font-mono" style={{ color: SPY }}>
          标普 {p.spy.toFixed(digits)}x
        </div>
      ) : null}
      {(p.buys.length > 0 || p.sells.length > 0) && (
        <div className="mt-1 font-mono text-zinc-500">
          {p.buys.length ? `买 ${p.buys.join(" ")}` : ""}
          {p.buys.length && p.sells.length ? " · " : ""}
          {p.sells.length ? `卖 ${p.sells.join(" ")}` : ""}
        </div>
      )}
    </div>
  );
}
