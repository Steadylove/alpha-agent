"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Alert,
  Badge,
  Button,
  Group,
  Loader,
  NumberInput,
  Table,
  Text,
  TextInput,
} from "@mantine/core";

import { Card, MetricCard } from "@/components/Card";
import type { FundPlan } from "@/lib/fund/plan";

type PositionRow = {
  symbol: string;
  entryDate: string;
  entryPrice: number;
  shares: number;
  cost: number;
  close: number;
  value: number;
  floatPnlPct: number;
  rps: number;
  entryRps: number;
  effectiveStop: number;
  stopDistancePct: number;
  stopHit: boolean;
};

type Snapshot = {
  asOf: string;
  plan: FundPlan;
  positions: PositionRow[];
  unresolved: { symbol: string; why: string }[];
  signalCount: number;
};

const money = (v: number) =>
  v.toLocaleString("en-US", { maximumFractionDigits: 0, minimumFractionDigits: 0 });

/** 成交回填：清单给的是建议价与计划金额，真实成交价和实付金额要人来改。 */
type FillDraft = { price: string; cash: string };

export function FundBoard() {
  const [data, setData] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, FillDraft>>({});
  const [cashAmount, setCashAmount] = useState<number | string>(100000);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/fund/plan");
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "生成清单失败");
      setData(json as Snapshot);
      setDrafts({});
    } catch (e) {
      setError(e instanceof Error ? e.message : "生成清单失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const post = async (body: Record<string, unknown>, key: string) => {
    setBusy(key);
    setError(null);
    try {
      const res = await fetch("/api/fund/fill", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "记账失败");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "记账失败");
    } finally {
      setBusy(null);
    }
  };

  const draftOf = (key: string, price: number, cash: number): FillDraft =>
    drafts[key] ?? { price: price.toFixed(2), cash: cash.toFixed(0) };

  const setDraft = (key: string, patch: Partial<FillDraft>, price: number, cash: number) =>
    setDrafts((prev) => ({ ...prev, [key]: { ...draftOf(key, price, cash), ...patch } }));

  if (loading && !data) {
    return (
      <Group justify="center" py="xl">
        <Loader size="sm" />
        <Text size="sm" c="dimmed">
          正在读账本、推吊灯、扫信号
        </Text>
      </Group>
    );
  }

  const plan = data?.plan;

  return (
    <div className="space-y-6">
      {error ? (
        <Alert color="red" variant="light">
          {error}
        </Alert>
      ) : null}

      {plan ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
          <MetricCard label="权益" value={money(plan.equity)} hint={`截至 ${data.asOf}`} />
          <MetricCard
            label="现金"
            value={money(plan.cash)}
            hint={`占 ${plan.equity > 0 ? ((plan.cash / plan.equity) * 100).toFixed(0) : "0"}%`}
          />
          <MetricCard label="持仓" value={`${data.positions.length}`} hint="只" />
          <MetricCard
            label="每笔金额"
            value={money(plan.slotAmount)}
            hint="权益的 12.5%"
          />
          <MetricCard label="当根信号" value={`${data.signalCount}`} hint="个" />
        </div>
      ) : null}

      {data && data.unresolved.length > 0 ? (
        <Alert color="orange" variant="light" title="有持仓对不上行情">
          {data.unresolved.map((u) => `${u.symbol}：${u.why}`).join("；")}
          。这些持仓算不出吊灯位，清单里不会给它们出止损单。
        </Alert>
      ) : null}

      <Card
        title={`明日开盘清单 · ${data?.asOf ?? ""}`}
        action={
          <Button size="xs" variant="light" onClick={() => void load()} loading={loading}>
            重算
          </Button>
        }
      >
        {plan && plan.sells.length === 0 && plan.buys.length === 0 ? (
          <Text size="sm" c="dimmed">
            没有要执行的动作。多数交易日都是这样,不用找事做。
          </Text>
        ) : null}

        {plan && plan.sells.length > 0 ? (
          <>
            <Text size="xs" fw={600} c="red.4" mb="xs">
              卖出
            </Text>
            <Table striped highlightOnHover mb="lg">
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>标的</Table.Th>
                  <Table.Th>原因</Table.Th>
                  <Table.Th ta="right">份额</Table.Th>
                  <Table.Th ta="right">估算回收</Table.Th>
                  <Table.Th>成交价</Table.Th>
                  <Table.Th>实收</Table.Th>
                  <Table.Th />
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {plan.sells.map((s) => {
                  const key = `sell:${s.symbol}`;
                  const d = draftOf(key, s.estProceeds / s.shares, s.estProceeds);
                  return (
                    <Table.Tr key={key}>
                      <Table.Td fw={600}>{s.symbol}</Table.Td>
                      <Table.Td>
                        {s.reason === "stop" ? (
                          <Badge color="red" variant="light" size="sm">
                            吊灯 {s.stop?.toFixed(2)}
                          </Badge>
                        ) : (
                          <Badge color="orange" variant="light" size="sm">
                            置换给 {s.replacedBy}
                          </Badge>
                        )}
                      </Table.Td>
                      <Table.Td ta="right" ff="monospace">
                        {s.shares.toFixed(4)}
                      </Table.Td>
                      <Table.Td ta="right" ff="monospace">
                        {money(s.estProceeds)}
                      </Table.Td>
                      <Table.Td>
                        <TextInput
                          size="xs"
                          w={90}
                          value={d.price}
                          onChange={(e) =>
                            setDraft(
                              key,
                              { price: e.currentTarget.value },
                              s.estProceeds / s.shares,
                              s.estProceeds,
                            )
                          }
                        />
                      </Table.Td>
                      <Table.Td>
                        <TextInput
                          size="xs"
                          w={100}
                          value={d.cash}
                          onChange={(e) =>
                            setDraft(
                              key,
                              { cash: e.currentTarget.value },
                              s.estProceeds / s.shares,
                              s.estProceeds,
                            )
                          }
                        />
                      </Table.Td>
                      <Table.Td>
                        <Button
                          size="xs"
                          variant="light"
                          loading={busy === key}
                          onClick={() =>
                            void post(
                              {
                                kind: "sell",
                                symbol: s.symbol,
                                date: data?.asOf,
                                price: Number(d.price),
                                proceeds: Number(d.cash),
                                reason: s.reason,
                              },
                              key,
                            )
                          }
                        >
                          记入
                        </Button>
                      </Table.Td>
                    </Table.Tr>
                  );
                })}
              </Table.Tbody>
            </Table>
          </>
        ) : null}

        {plan && plan.buys.length > 0 ? (
          <>
            <Text size="xs" fw={600} c="teal.4" mb="xs">
              买入
            </Text>
            <Table striped highlightOnHover>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>标的</Table.Th>
                  <Table.Th>信号</Table.Th>
                  <Table.Th ta="right">RPS</Table.Th>
                  <Table.Th ta="right">计划投入</Table.Th>
                  <Table.Th>成交价</Table.Th>
                  <Table.Th>实付</Table.Th>
                  <Table.Th />
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {plan.buys.map((b) => {
                  const key = `buy:${b.symbol}`;
                  const d = draftOf(key, b.refPrice, b.amount);
                  return (
                    <Table.Tr key={key}>
                      <Table.Td fw={600}>{b.symbol}</Table.Td>
                      <Table.Td>
                        <Badge variant="light" size="sm" color={b.sigType === 1 ? "blue" : "grape"}>
                          {b.sigType === 1 ? "一买" : "二买"}
                        </Badge>
                        {b.replaces ? (
                          <Text span size="xs" c="dimmed" ml={6}>
                            顶掉 {b.replaces}
                          </Text>
                        ) : null}
                      </Table.Td>
                      <Table.Td ta="right" ff="monospace">
                        {b.rps.toFixed(0)}
                      </Table.Td>
                      <Table.Td ta="right" ff="monospace">
                        {money(b.amount)}
                      </Table.Td>
                      <Table.Td>
                        <TextInput
                          size="xs"
                          w={90}
                          value={d.price}
                          onChange={(e) =>
                            setDraft(key, { price: e.currentTarget.value }, b.refPrice, b.amount)
                          }
                        />
                      </Table.Td>
                      <Table.Td>
                        <TextInput
                          size="xs"
                          w={100}
                          value={d.cash}
                          onChange={(e) =>
                            setDraft(key, { cash: e.currentTarget.value }, b.refPrice, b.amount)
                          }
                        />
                      </Table.Td>
                      <Table.Td>
                        <Button
                          size="xs"
                          variant="light"
                          color="teal"
                          loading={busy === key}
                          onClick={() =>
                            void post(
                              {
                                kind: "buy",
                                symbol: b.symbol,
                                date: data?.asOf,
                                price: Number(d.price),
                                cost: Number(d.cash),
                                rps: b.rps,
                                sigType: b.sigType,
                                timeframe: "1d",
                              },
                              key,
                            )
                          }
                        >
                          记入
                        </Button>
                      </Table.Td>
                    </Table.Tr>
                  );
                })}
              </Table.Tbody>
            </Table>
          </>
        ) : null}

        {plan && plan.passes.length > 0 ? (
          <div className="mt-4 space-y-1">
            <Text size="xs" fw={600} c="dimmed">
              放弃的信号
            </Text>
            {plan.passes.map((p) => (
              <Text key={p.symbol} size="xs" c="dimmed">
                {p.symbol}（RPS {p.rps.toFixed(0)}）— {p.why}
              </Text>
            ))}
          </div>
        ) : null}
      </Card>

      <Card title="当前持仓">
        {data && data.positions.length === 0 ? (
          <Text size="sm" c="dimmed">
            账本里没有未平仓持仓。
          </Text>
        ) : (
          <Table striped highlightOnHover>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>标的</Table.Th>
                <Table.Th>开仓日</Table.Th>
                <Table.Th ta="right">成本价</Table.Th>
                <Table.Th ta="right">现价</Table.Th>
                <Table.Th ta="right">浮盈</Table.Th>
                <Table.Th ta="right">市值</Table.Th>
                <Table.Th ta="right">吊灯</Table.Th>
                <Table.Th ta="right">距吊灯</Table.Th>
                <Table.Th ta="right">RPS</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {data?.positions.map((p) => (
                <Table.Tr key={p.symbol}>
                  <Table.Td fw={600}>
                    {p.symbol}
                    {p.stopHit ? (
                      <Badge color="red" variant="filled" size="xs" ml={6}>
                        该走
                      </Badge>
                    ) : null}
                  </Table.Td>
                  <Table.Td c="dimmed">{p.entryDate}</Table.Td>
                  <Table.Td ta="right" ff="monospace">
                    {p.entryPrice.toFixed(2)}
                  </Table.Td>
                  <Table.Td ta="right" ff="monospace">
                    {p.close.toFixed(2)}
                  </Table.Td>
                  <Table.Td
                    ta="right"
                    ff="monospace"
                    c={p.floatPnlPct >= 0 ? "teal.4" : "red.4"}
                  >
                    {p.floatPnlPct >= 0 ? "+" : ""}
                    {p.floatPnlPct.toFixed(1)}%
                  </Table.Td>
                  <Table.Td ta="right" ff="monospace">
                    {money(p.value)}
                  </Table.Td>
                  <Table.Td ta="right" ff="monospace">
                    {p.effectiveStop.toFixed(2)}
                  </Table.Td>
                  <Table.Td ta="right" ff="monospace" c={p.stopDistancePct < 3 ? "orange.4" : undefined}>
                    {p.stopDistancePct.toFixed(1)}%
                  </Table.Td>
                  <Table.Td ta="right" ff="monospace">
                    {p.rps.toFixed(0)}
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        )}
      </Card>

      <Card title="注资 / 提取">
        <Group align="flex-end">
          <NumberInput
            label="金额"
            description="正数注资，负数提取"
            value={cashAmount}
            onChange={setCashAmount}
            w={220}
            thousandSeparator=","
          />
          <Button
            variant="light"
            loading={busy === "cash"}
            onClick={() =>
              void post({ kind: "cash", amount: Number(cashAmount), date: data?.asOf }, "cash")
            }
          >
            记入账本
          </Button>
        </Group>
      </Card>
    </div>
  );
}
