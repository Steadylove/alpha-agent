"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Group, SegmentedControl, Stack, Table, Text } from "@mantine/core";

import { Card } from "@/components/Card";
import { LabFundChart } from "@/components/LabFundChart";
import { LabSymbolChart, type ChartTarget } from "@/components/LabSymbolChart";
import type { DayBook, HoldingDay, YearRow, YearToDate } from "@/lib/backtest/engine";
import { CHAMP_TABS, type ChampId } from "@/lib/fund/champsMeta";

type FrozenLabResult = {
  champ: { id: ChampId; name: string; note: string; label: string };
  stats: {
    cagr: number;
    dd: number;
    mar: number;
    entries: number;
    rotations: number;
    missed: number;
    avgHoldings: number;
    avgExposure: number;
    tradesPerYear: number;
  };
  book: DayBook[];
  holdings: HoldingDay[];
  trades: { symbol: string; sigType: 1 | 2; entryDate: string; exitDate: string; pnlPct: number }[];
  byYear: YearRow[];
  ytd: YearToDate | null;
  universeSize: number;
  elapsedMs: number;
};

const POS = "#089981";
const NEG = "#f23645";
const STAT_SLOTS = ["CAGR", "回撤", "MAR", "均持", "敞口", "年换手", "入场", "置换"] as const;

const pct = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`;
const tone = (v: number) => (v >= 0 ? POS : NEG);

export function LabWorkbench() {
  const [tf, setTf] = useState<ChampId>("4h");
  const [cache, setCache] = useState<Partial<Record<ChampId, FrozenLabResult>>>({});
  const [pending, setPending] = useState<ChampId | null>("4h");
  const [error, setError] = useState<string | null>(null);
  const [chartTarget, setChartTarget] = useState<ChartTarget | null>(null);
  const chartRequest = useMemo(() => ({ champ: tf, index: "SMALLFUND" }), [tf]);
  const cacheRef = useRef(cache);
  cacheRef.current = cache;

  useEffect(() => {
    if (cacheRef.current[tf]) {
      setPending(null);
      return;
    }
    let cancelled = false;
    setPending(tf);
    setError(null);
    void (async () => {
      try {
        const res = await fetch(`/api/lab/frozen?tf=${tf}`);
        const json = (await res.json()) as FrozenLabResult & { error?: string };
        if (!res.ok) throw new Error(json.error ?? "回测失败");
        if (cancelled) return;
        setCache((prev) => ({ ...prev, [tf]: json }));
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "回测失败");
      } finally {
        if (!cancelled) setPending((cur) => (cur === tf ? null : cur));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tf]);

  const tab = CHAMP_TABS.find((c) => c.id === tf) ?? CHAMP_TABS[0];
  const result = cache[tf] ?? null;
  const loading = pending === tf && !result;

  return (
    <Stack gap="md">
      <Card>
        <Stack gap={8}>
          <SegmentedControl
            size="sm"
            fullWidth
            value={tf}
            onChange={(v) => setTf(v as ChampId)}
            data={CHAMP_TABS.map((c) => ({ value: c.id, label: c.name }))}
          />
          <Text size="xs" c="dimmed" lh={1.55} style={{ minHeight: 40 }}>
            {tab.label}
            {tab.note ? (
              <>
                <br />
                {tab.note}
                {result ? ` · ${result.universeSize} 只有价` : ""}
              </>
            ) : null}
          </Text>
        </Stack>
      </Card>

      {error && !result ? (
        <Text size="sm" c="red">
          {error}
        </Text>
      ) : null}

      <LabSymbolChart
        target={chartTarget}
        request={chartRequest}
        onClose={() => setChartTarget(null)}
      />

      {loading || !result ? (
        <LabSkeleton />
      ) : (
        <Stack gap="md">
          <Card>
            <Group gap="xl" wrap="nowrap">
              <Stat label="CAGR" value={pct(result.stats.cagr)} color={tone(result.stats.cagr)} />
              <Stat label="回撤" value={`${result.stats.dd.toFixed(0)}%`} color={NEG} />
              <Stat label="MAR" value={result.stats.mar.toFixed(2)} />
              <Stat label="均持" value={result.stats.avgHoldings.toFixed(1)} />
              <Stat label="敞口" value={`${result.stats.avgExposure.toFixed(0)}%`} />
              <Stat label="年换手" value={result.stats.tradesPerYear.toFixed(0)} />
              <Stat label="入场" value={String(result.stats.entries)} />
              <Stat label="置换" value={String(result.stats.rotations)} />
            </Group>
          </Card>

          <LabFundChart
            book={result.book}
            holdings={result.holdings}
            ytd={result.ytd}
            trades={result.trades}
            splitDate="2099-01-01"
            maskAfterSplit={false}
            externalLabel="QQQ"
            onPick={(symbol, entryDate) => setChartTarget({ symbol, entryDate })}
          />

          <Card title="分年">
            <Table verticalSpacing={4} fz="xs">
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>年</Table.Th>
                  <Table.Th ta="right">策略</Table.Th>
                  <Table.Th ta="right">同池</Table.Th>
                  <Table.Th ta="right">QQQ</Table.Th>
                  <Table.Th ta="right">平仓</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {result.byYear.map((r) => (
                  <Table.Tr key={r.year}>
                    <Table.Td ff="monospace">{r.year}</Table.Td>
                    <Table.Td ta="right" ff="monospace" style={{ color: tone(r.strategyPct) }}>
                      {pct(r.strategyPct)}
                    </Table.Td>
                    <Table.Td ta="right" ff="monospace" c="dimmed">
                      {pct(r.benchmarkPct)}
                    </Table.Td>
                    <Table.Td ta="right" ff="monospace" c="dimmed">
                      {r.spyPct == null ? "—" : pct(r.spyPct)}
                    </Table.Td>
                    <Table.Td ta="right" ff="monospace" c="dimmed">
                      {r.trades}
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Card>
        </Stack>
      )}
    </Stack>
  );
}

function Bone({ h, w }: { h: number; w?: string | number }) {
  return (
    <div
      className="animate-pulse rounded-sm bg-white/[0.06]"
      style={{ height: h, width: w ?? "100%" }}
    />
  );
}

function LabSkeleton() {
  return (
    <Stack gap="md">
      <Card>
        <Group gap="xl" wrap="nowrap">
          {STAT_SLOTS.map((label) => (
            <Stack key={label} gap={8} w={64}>
              <Text size="xs" c="dimmed">
                {label}
              </Text>
              <Bone h={28} />
            </Stack>
          ))}
        </Group>
      </Card>

      <Card title="净值">
        <Bone h={280} />
      </Card>

      <Card title="持仓">
        <Stack gap={8}>
          <Bone h={14} w="40%" />
          <Bone h={14} />
          <Bone h={14} />
          <Bone h={14} w="70%" />
          <Bone h={14} w="55%" />
        </Stack>
      </Card>

      <Card title="分年">
        <Stack gap={10}>
          <Bone h={12} w="30%" />
          {Array.from({ length: 6 }, (_, i) => (
            <Bone key={i} h={14} />
          ))}
        </Stack>
      </Card>
    </Stack>
  );
}

function Stat({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <Stack gap={2} w={64}>
      <Text size="xs" c="dimmed">
        {label}
      </Text>
      <Text size="lg" fw={600} ff="monospace" style={color ? { color } : undefined}>
        {value}
      </Text>
    </Stack>
  );
}
