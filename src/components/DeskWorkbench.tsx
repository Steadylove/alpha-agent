"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Group, Loader, SegmentedControl, Table, Text, TextInput } from "@mantine/core";

import { Card } from "@/components/Card";
import { LabSymbolChart, type ChartTarget } from "@/components/LabSymbolChart";
import type { DeskBarState, DeskBoardRow } from "@/lib/backtest/deskScan";

type Board = {
  poolSize: number;
  h4: { asOf: string; universeSize: number };
  h2: { asOf: string; universeSize: number };
  rows: DeskBoardRow[];
  elapsedMs: number;
};

const H4_CHART = {
  index: "SMALLFUND",
  timeframe: "4h",
  poolId: "sf-broad",
  stopMult: 4,
  trailMult: 6,
  takeProfitR: 3,
  rpsMin: 30,
  requireRsi: true,
  minRsi: 30,
  rpsExit: null,
} as const;

const H2_CHART = {
  index: "SMALLFUND",
  timeframe: "2h",
  poolId: "sf-broad",
  stopMult: 6,
  trailMult: 8,
  takeProfitR: null,
  rpsMin: 0,
  requireRsi: true,
  minRsi: 30,
  rpsExit: 10,
} as const;

function axisLabel(raw: string): string {
  const [day, time] = raw.split("T");
  return time ? `${day} ${time}` : day;
}

function specRows(chart: typeof H4_CHART | typeof H2_CHART): [string, string][] {
  const rows: [string, string][] = [
    ["止损", `${chart.stopMult} × ATR`],
    ["吊灯", `${chart.trailMult} × ATR`],
    ["止盈", chart.takeProfitR == null ? "无固定止盈" : `${chart.takeProfitR}R`],
    ["RPS 门槛", chart.rpsMin > 0 ? `≥ ${chart.rpsMin}` : "不设"],
    ["RSI", chart.requireRsi ? `≥ ${chart.minRsi}` : "不设"],
  ];
  if (chart.rpsExit != null) rows.push(["转弱离场", `RPS < ${chart.rpsExit}`]);
  return rows;
}

function isLive(row: DeskBoardRow): boolean {
  return Boolean(row.h4?.lastSignal || row.h4?.holding || row.h2?.lastSignal || row.h2?.holding);
}

function matchRows(rows: DeskBoardRow[], query: string): DeskBoardRow[] {
  const q = query.trim().toUpperCase();
  return q ? rows.filter((r) => r.symbol.includes(q)) : rows.filter(isLive);
}

function sigName(n: 1 | 2): string {
  return n === 1 ? "一买" : "二买";
}

const BUY1 = "#ff4976";
const BUY2 = "#fbbf24";

function TfCell({ state }: { state: DeskBarState | null }) {
  if (!state) return <span className="text-zinc-600">—</span>;
  if (!state.lastSignal && !state.holding) return <span className="text-zinc-600">空</span>;

  const sig = state.lastSignal || state.holding?.sigType;
  const sigColor = sig === 1 ? BUY1 : sig === 2 ? BUY2 : undefined;
  const pnl = state.holding?.floatPnlPct;
  const pnlColor = pnl == null ? undefined : pnl >= 0 ? "var(--pos)" : "var(--neg)";

  return (
    <span className="inline-flex items-baseline gap-2 font-mono text-xs leading-none">
      {state.lastSignal ? (
        <span
          className="rounded px-1 py-px font-semibold"
          style={{ color: sigColor, background: "var(--accent-soft)" }}
        >
          本根{sigName(state.lastSignal)}
        </span>
      ) : sig ? (
        <span className="font-medium" style={{ color: sigColor }}>
          {sigName(sig)}
        </span>
      ) : null}
      {pnl != null ? (
        <span className="font-semibold" style={{ color: pnlColor }}>
          {`${pnl >= 0 ? "+" : ""}${pnl.toFixed(1)}%`}
        </span>
      ) : null}
    </span>
  );
}

function SpecPane({
  title,
  asOf,
  rows,
}: {
  title: string;
  asOf: string | null;
  rows: [string, string][];
}) {
  return (
    <div className="rounded-lg border border-(--border-subtle) bg-(--surface-sunken) p-4">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <Text size="sm" fw={600} c="gray.1">
          {title}
        </Text>
        <Text size="xs" c="dimmed" ff={asOf ? "monospace" : undefined}>
          {asOf ? `截至 ${asOf}` : "扫描中…"}
        </Text>
      </div>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2.5 sm:grid-cols-3">
        {rows.map(([label, value]) => (
          <div key={label}>
            <dt>
              <Text size="xs" c="dimmed">
                {label}
              </Text>
            </dt>
            <dd className="m-0">
              <Text size="sm" fw={600} c="gray.1">
                {value}
              </Text>
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function QuietStrip({
  rows,
  onOpen,
}: {
  rows: DeskBoardRow[];
  onOpen: (row: DeskBoardRow) => void;
}) {
  if (rows.length === 0) return null;
  return (
    <div className="mb-3 rounded-lg border border-(--border-subtle) bg-(--surface-sunken) px-3 py-2.5">
      <Text size="xs" c="dimmed" mb={8}>
        其余 {rows.length} 只 · 这根没有仓也没有买点
      </Text>
      <div className="flex flex-wrap gap-x-3 gap-y-1.5">
        {rows.map((row) => (
          <button
            key={row.symbol}
            type="button"
            title={`查看 ${row.symbol}`}
            className="cursor-pointer font-mono text-xs text-zinc-400 underline decoration-zinc-700 underline-offset-2 hover:text-zinc-100 hover:decoration-(--accent)"
            onClick={() => onOpen(row)}
          >
            {row.symbol}
          </button>
        ))}
      </div>
    </div>
  );
}

function TfButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      className="w-full cursor-pointer rounded-md px-1.5 py-1 text-left transition-colors duration-150 hover:bg-[var(--accent-soft)]"
    >
      {children}
    </button>
  );
}

export function DeskWorkbench() {
  const [data, setData] = useState<Board | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [chartTf, setChartTf] = useState<"4h" | "2h">("4h");
  const [chartTarget, setChartTarget] = useState<ChartTarget | null>(null);
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<"live" | "all">("live");
  const request = useMemo(() => (chartTf === "2h" ? H2_CHART : H4_CHART), [chartTf]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/desk/signals");
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "扫描失败");
      setData(json as Board);
    } catch (e) {
      setError(e instanceof Error ? e.message : "扫描失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const open = (symbol: string, tf: "4h" | "2h", state: DeskBarState | null) => {
    setChartTf(tf);
    setChartTarget({ symbol, entryDate: state?.holding?.entryDate ?? "" });
  };

  const liveCount = data?.rows.filter(isLive).length ?? 0;
  const rest = data?.rows.filter((r) => !isLive(r)) ?? [];
  const shown = data ? matchRows(data.rows, query) : [];

  return (
    <div className="space-y-6">
      <Card title="定档">
        <div className="grid gap-4 md:grid-cols-2">
          <SpecPane
            title="4 小时"
            asOf={data ? axisLabel(data.h4.asOf) : null}
            rows={specRows(H4_CHART)}
          />
          <SpecPane
            title="2 小时"
            asOf={data ? axisLabel(data.h2.asOf) : null}
            rows={specRows(H2_CHART)}
          />
        </div>
        <Text size="xs" c="dimmed" mt="md">
          股票池与资金账本同一份。
        </Text>
      </Card>

      {error ? (
        <Card>
          <Text size="sm" c="red.4">
            {error}
          </Text>
        </Card>
      ) : null}

      {data ? (
        <Card title="4H / 2H">
          <Group justify="space-between" align="flex-end" wrap="wrap" gap="sm" mb="sm">
            <TextInput
              size="xs"
              label="找代码"
              placeholder="NVDA"
              value={query}
              onChange={(e) => setQuery(e.currentTarget.value.toUpperCase())}
              w={140}
            />
            <SegmentedControl
              size="xs"
              value={scope}
              onChange={(v) => setScope(v as "live" | "all")}
              disabled={Boolean(query.trim())}
              data={[
                { value: "live", label: `有动作 ${liveCount}` },
                { value: "all", label: `全部 ${data.rows.length}` },
              ]}
            />
          </Group>
          <Text size="xs" c="dimmed" mb="sm">
            {query
              ? `找到 ${shown.length} 只`
              : scope === "live"
                ? "默认只看有仓或本根买点的。搜代码或切全部，看其余的。"
                : `池 ${data.poolSize} 只。有动作在表里，其余 ${rest.length} 只在上面。`}
          </Text>
          {!query && scope === "all" ? (
            <QuietStrip rows={rest} onOpen={(row) => open(row.symbol, "4h", row.h4)} />
          ) : null}
          <div className="max-h-[420px] overflow-y-auto" style={{ scrollbarGutter: "stable" }}>
            {shown.length === 0 ? (
              <Text size="sm" c="dimmed" py="md">
                {query ? "名单里没有这个代码" : "这根没有持仓也没有买点"}
              </Text>
            ) : (
              <Table verticalSpacing={0} horizontalSpacing={8} fz="xs" className="[&_td]:py-1.5 [&_th]:py-2">
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>标的</Table.Th>
                    <Table.Th>4 小时</Table.Th>
                    <Table.Th>2 小时</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {shown.map((row) => (
                    <Table.Tr key={row.symbol}>
                      <Table.Td>
                        <button
                          type="button"
                          title={`查看 ${row.symbol} 4小时图`}
                          aria-label={`查看 ${row.symbol} 4小时图`}
                          className="cursor-pointer font-mono text-sm font-semibold text-zinc-100 underline decoration-zinc-600 underline-offset-2 hover:text-white hover:decoration-(--accent)"
                          onClick={() => open(row.symbol, "4h", row.h4)}
                        >
                          {row.symbol}
                        </button>
                      </Table.Td>
                      <Table.Td>
                        <TfButton
                          label={`查看 ${row.symbol} 4小时图${row.h4 ? ` · RPS ${row.h4.rps.toFixed(0)} · ${row.h4.close.toFixed(2)}` : ""}`}
                          onClick={() => open(row.symbol, "4h", row.h4)}
                        >
                          <TfCell state={row.h4} />
                        </TfButton>
                      </Table.Td>
                      <Table.Td>
                        <TfButton
                          label={`查看 ${row.symbol} 2小时图${row.h2 ? ` · RPS ${row.h2.rps.toFixed(0)} · ${row.h2.close.toFixed(2)}` : ""}`}
                          onClick={() => open(row.symbol, "2h", row.h2)}
                        >
                          <TfCell state={row.h2} />
                        </TfButton>
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            )}
          </div>
        </Card>
      ) : loading ? (
        <Card>
          <Group gap="sm">
            <Loader size="sm" color="gray" />
            <Text size="sm" c="dimmed">
              正在扫 4H 和 2H，首次可能要十几秒。
            </Text>
          </Group>
        </Card>
      ) : null}

      <LabSymbolChart target={chartTarget} request={request} onClose={() => setChartTarget(null)} />
    </div>
  );
}
