"use client";

import { useCallback, useEffect, useState } from "react";
import { Badge, Button, Group, Loader, SegmentedControl, Table, Text, TextInput } from "@mantine/core";

import { Card, MetricCard } from "@/components/Card";
import { LiveBookCard } from "@/components/LiveBookCard";
import type { DeskDecision } from "@/lib/backtest/deskLedger";
import type { DeskHolding, DeskSignal } from "@/lib/backtest/deskScan";
import {
  SMALL_FUND_POOLS,
  SMALL_FUND_POOL_IDS,
  type SmallFundPoolId,
} from "@/lib/backtest/smallFundPools";

type Timeframe = "1d" | "4h";

type PendingRow = DeskSignal & { decision: DeskDecision | null };

type Snapshot = {
  timeframe: Timeframe;
  poolId: SmallFundPoolId;
  poolLabel: string;
  asOf: string;
  universeSize: number;
  holdings: DeskHolding[];
  pending: PendingRow[];
  holdingExposurePct: number;
  pendingExposurePct: number;
  cashPct: number;
  ledger: DeskDecision[];
  elapsedMs: number;
};

const POOL_OPTIONS = SMALL_FUND_POOL_IDS.map((id) => ({
  value: id,
  label: SMALL_FUND_POOLS[id].label,
}));

const pct = (v: number) => `${v.toFixed(1)}%`;

export function DeskWorkbench() {
  const [timeframe, setTimeframe] = useState<Timeframe>("1d");
  const [poolId, setPoolId] = useState<SmallFundPoolId>("sf-live");
  const [data, setData] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});

  const load = useCallback(async (tf: Timeframe, pool: SmallFundPoolId) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/desk/signals?timeframe=${tf}&poolId=${pool}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "扫描失败");
      setData(json as Snapshot);
    } catch (e) {
      setError(e instanceof Error ? e.message : "扫描失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(timeframe, poolId);
  }, [timeframe, poolId, load]);

  const decide = async (row: PendingRow, decision: "confirm" | "reject") => {
    const key = `${row.date}|${row.symbol}|${row.sigType}`;
    await fetch("/api/desk/decision", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...row,
        timeframe,
        poolId,
        decision,
        note: notes[key] ?? "",
      }),
    });
    await load(timeframe, poolId);
  };

  const rule =
    timeframe === "4h"
      ? "Vegas+RSI · RPS≥50 · 止损 6 · 吊灯 6 · 不止盈 · k=1 留现金"
      : "Vegas+RSI · RPS≥40 · 止损 4 · 吊灯 5.5 · 不止盈 · k=1 留现金";

  return (
    <StackLike>
      <Card
        title="当前池"
        action={
          <Group gap="xs">
            {loading ? <Loader size="xs" color="gray" /> : null}
            <Text size="xs" c="dimmed" ff="monospace">
              {data ? `${data.elapsedMs}ms` : ""}
            </Text>
          </Group>
        }
      >
        <Group gap="sm" align="center" wrap="wrap">
          <SegmentedControl
            size="xs"
            value={timeframe}
            onChange={(v) => setTimeframe(v as Timeframe)}
            data={[
              { value: "1d", label: "日线" },
              { value: "4h", label: "4小时" },
            ]}
          />
          <SegmentedControl
            size="xs"
            value={poolId}
            onChange={(v) => setPoolId(v as SmallFundPoolId)}
            data={POOL_OPTIONS}
          />
        </Group>
        <Text size="xs" c="dimmed" mt="sm">
          {rule}。默认活账本。下一根开盘成交。人不改公式，只拍板。
        </Text>
      </Card>

      {error ? (
        <Card>
          <Text size="sm" c="red.4">
            {error}
          </Text>
        </Card>
      ) : null}

      {poolId === "sf-live" ? (
        <LiveBookCard asOf={data?.asOf} onChanged={() => void load(timeframe, poolId)} />
      ) : null}

      {data ? (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <MetricCard label="最新一根" value={data.asOf} />
            <MetricCard label="待执行" value={String(data.pending.length)} />
            <MetricCard label="已持仓" value={String(data.holdings.length)} />
            <MetricCard label="现金" value={pct(data.cashPct)} hint={`持仓 ${pct(data.holdingExposurePct)} · 新开 ${pct(data.pendingExposurePct)}`} />
          </div>

          <Card title={`待执行 · ${data.poolLabel} · ${data.universeSize} 只`}>
            {data.pending.length === 0 ? (
              <Text size="sm" c="dimmed">
                本根无新买点。现金 {pct(data.cashPct)}。
              </Text>
            ) : (
              <Table verticalSpacing={6} horizontalSpacing={6} fz="xs">
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>标的</Table.Th>
                    <Table.Th>信号</Table.Th>
                    <Table.Th ta="right">RPS</Table.Th>
                    <Table.Th ta="right">仓位</Table.Th>
                    <Table.Th ta="right">收盘</Table.Th>
                    <Table.Th>状态</Table.Th>
                    <Table.Th>备注</Table.Th>
                    <Table.Th />
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {data.pending.map((row) => {
                    const key = `${row.date}|${row.symbol}|${row.sigType}`;
                    return (
                      <Table.Tr key={key}>
                        <Table.Td ff="monospace" fw={600}>
                          {row.symbol}
                        </Table.Td>
                        <Table.Td>{row.sigType === 1 ? "一买" : "二买"}</Table.Td>
                        <Table.Td ta="right" ff="monospace">
                          {row.rps.toFixed(0)}
                        </Table.Td>
                        <Table.Td ta="right" ff="monospace">
                          {pct(row.weightPct)}
                        </Table.Td>
                        <Table.Td ta="right" ff="monospace">
                          {row.close.toFixed(2)}
                        </Table.Td>
                        <Table.Td>
                          {row.decision ? (
                            <Badge size="xs" color={row.decision.decision === "confirm" ? "teal" : "red"} variant="light">
                              {row.decision.decision === "confirm" ? "已确认" : "已否决"}
                            </Badge>
                          ) : (
                            <Badge size="xs" color="gray" variant="light">
                              待拍板
                            </Badge>
                          )}
                        </Table.Td>
                        <Table.Td>
                          <TextInput
                            size="xs"
                            placeholder="理由"
                            value={notes[key] ?? row.decision?.note ?? ""}
                            onChange={(e) =>
                              setNotes((prev) => ({ ...prev, [key]: e.currentTarget.value }))
                            }
                          />
                        </Table.Td>
                        <Table.Td>
                          <Group gap={4} justify="flex-end">
                            <Button size="compact-xs" color="teal" variant="light" onClick={() => void decide(row, "confirm")}>
                              确认
                            </Button>
                            <Button size="compact-xs" color="red" variant="light" onClick={() => void decide(row, "reject")}>
                              否决
                            </Button>
                          </Group>
                        </Table.Td>
                      </Table.Tr>
                    );
                  })}
                </Table.Tbody>
              </Table>
            )}
          </Card>

          <Card title="回测账本持仓（机器按纪律拿到现在）">
            {data.holdings.length === 0 ? (
              <Text size="sm" c="dimmed">
                当前空仓。
              </Text>
            ) : (
              <Table verticalSpacing={6} horizontalSpacing={6} fz="xs">
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>标的</Table.Th>
                    <Table.Th>信号</Table.Th>
                    <Table.Th>开仓</Table.Th>
                    <Table.Th ta="right">仓位</Table.Th>
                    <Table.Th ta="right">浮盈</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {data.holdings.map((row) => (
                    <Table.Tr key={row.symbol}>
                      <Table.Td ff="monospace" fw={600}>
                        {row.symbol}
                      </Table.Td>
                      <Table.Td>{row.sigType === 1 ? "一买" : "二买"}</Table.Td>
                      <Table.Td ff="monospace" c="dimmed">
                        {row.entryDate ?? "—"}
                      </Table.Td>
                      <Table.Td ta="right" ff="monospace">
                        {pct(row.weightPct)}
                      </Table.Td>
                      <Table.Td ta="right" ff="monospace" c={row.floatPnlPct >= 0 ? "teal.4" : "red.4"}>
                        {`${row.floatPnlPct >= 0 ? "+" : ""}${row.floatPnlPct.toFixed(2)}%`}
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            )}
          </Card>

          {data.ledger.length > 0 ? (
            <Card title="拍板记录">
              <Table verticalSpacing={4} horizontalSpacing={6} fz="xs">
                <Table.Tbody>
                  {data.ledger.map((row) => (
                    <Table.Tr key={row.id}>
                      <Table.Td ff="monospace">{row.date}</Table.Td>
                      <Table.Td ff="monospace" fw={600}>
                        {row.symbol}
                      </Table.Td>
                      <Table.Td>{row.decision === "confirm" ? "确认" : "否决"}</Table.Td>
                      <Table.Td c="dimmed">{row.note || "—"}</Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </Card>
          ) : null}
        </>
      ) : loading ? (
        <Card>
          <Group gap="sm">
            <Loader size="sm" color="gray" />
            <Text size="sm" c="dimmed">
              首次要预处理全池（十几秒），之后换周期还会再准备一份。
            </Text>
          </Group>
        </Card>
      ) : null}
    </StackLike>
  );
}

function StackLike({ children }: { children: React.ReactNode }) {
  return <div className="space-y-6">{children}</div>;
}
