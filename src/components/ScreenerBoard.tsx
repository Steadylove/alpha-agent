"use client";

import { Card } from "@/components/Card";
import { TradingViewChart } from "@/components/TradingViewChart";
import type { ScreenerPageData } from "@/lib/dashboard/screener";
import type { ScreenerRow } from "@/lib/jobs/alphaScreener";
import type { Playbook } from "@/lib/scoring/rpsPlaybooks";
import { Badge, Group, Stack, Text, UnstyledButton } from "@mantine/core";
import { useMemo, useState } from "react";

const PLAYBOOK_ACCENT: Record<Playbook, string> = {
  PULLBACK: "orange",
  CLIMAX_FILTER: "blue",
  EARLY_ACCELERATION: "teal",
};

export function ScreenerBoard({ data }: { data: ScreenerPageData }) {
  const firstPick = data.buckets.find((b) => b.picks.length > 0)?.picks[0] ?? null;
  const [activePlaybook, setActivePlaybook] = useState<Playbook>(
    data.buckets.find((b) => b.picks.length > 0)?.playbook ?? "PULLBACK",
  );
  const [selected, setSelected] = useState<ScreenerRow | null>(firstPick);

  const activeBucket = useMemo(
    () => data.buckets.find((b) => b.playbook === activePlaybook) ?? data.buckets[0],
    [data.buckets, activePlaybook],
  );

  return (
    <Stack gap="lg">
      <Group gap="sm" wrap="wrap">
        {data.buckets.map((bucket) => {
          const active = bucket.playbook === activePlaybook;
          return (
            <UnstyledButton
              key={bucket.playbook}
              onClick={() => {
                setActivePlaybook(bucket.playbook);
                if (bucket.picks[0]) setSelected(bucket.picks[0]);
              }}
              style={{
                borderRadius: 10,
                border: active
                  ? `1px solid var(--mantine-color-${PLAYBOOK_ACCENT[bucket.playbook]}-5)`
                  : "1px solid #27272a",
                background: active ? "#18181b" : "#09090b",
                padding: "10px 14px",
                minWidth: 180,
              }}
            >
              <Group justify="space-between" gap="xs">
                <Text size="sm" fw={600} c={active ? "zinc.1" : "dimmed"}>
                  {bucket.meta.emoji} {bucket.meta.name}
                </Text>
                <Badge size="sm" color={PLAYBOOK_ACCENT[bucket.playbook]} variant="light">
                  {bucket.totalMatches}
                </Badge>
              </Group>
              <Text size="xs" c="dimmed" mt={4} lineClamp={1}>
                {bucket.meta.slogan}
              </Text>
            </UnstyledButton>
          );
        })}
      </Group>

      <Card
        title={`${activeBucket.meta.emoji} ${activeBucket.meta.name}`}
        action={
          <Text size="xs" c="dimmed">
            命中 {activeBucket.totalMatches} · 强势池 {data.elite.length}
          </Text>
        }
      >
        <Stack gap="sm">
          <Text size="sm" c="gray.3">
            {activeBucket.meta.slogan}
          </Text>
          <Text size="xs" c="dimmed">
            生命周期：{activeBucket.meta.stage}
          </Text>
          <Text size="xs" c="dimmed" ff="monospace">
            {activeBucket.meta.rule}
          </Text>

          {activeBucket.picks.length === 0 ? (
            <Text size="sm" c="dimmed" py="md">
              今日该战法无符合条件标的。
            </Text>
          ) : (
            <div className="overflow-x-auto -mx-1">
              <table className="w-full text-sm whitespace-nowrap">
                <thead>
                  <tr>
                    <th className="w-10 text-center">#</th>
                    <th>Symbol</th>
                    <th className="text-right">Score</th>
                    <th className="text-right">20D</th>
                    <th className="text-right">50D</th>
                    <th className="text-right">120D</th>
                    <th className="text-right">250D</th>
                    <th className="text-right">Sector</th>
                  </tr>
                </thead>
                <tbody>
                  {activeBucket.picks.map((row, idx) => {
                    const isSelected = selected?.symbol === row.symbol;
                    return (
                      <tr
                        key={`${activeBucket.playbook}-${row.symbol}`}
                        onClick={() => setSelected(row)}
                        style={{
                          cursor: "pointer",
                          background: isSelected ? "rgba(39, 39, 42, 0.9)" : undefined,
                        }}
                      >
                        <td className="text-center text-zinc-500">{idx + 1}</td>
                        <td>
                          <div className="font-medium text-zinc-100">{row.symbol}</div>
                          <div className="text-xs text-zinc-500">{row.name}</div>
                        </td>
                        <td className="text-right font-medium text-emerald-400">
                          {row.playbookScore.toFixed(1)}
                        </td>
                        <td className="text-right text-zinc-300">{Math.round(row.rps[20])}</td>
                        <td className="text-right text-zinc-300">{Math.round(row.rps[50])}</td>
                        <td className="text-right text-zinc-300">{Math.round(row.rps[120])}</td>
                        <td className="text-right text-zinc-300">{Math.round(row.rps[250])}</td>
                        <td className="text-right text-zinc-500">{row.sector ?? "-"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Stack>
      </Card>

      {selected ? (
        <TradingViewChart
          key={`${selected.symbol}-${activePlaybook}`}
          symbol={selected.symbol}
          name={selected.name}
          playbook={activePlaybook}
        />
      ) : (
        <Card title="Chart">
          <Text size="sm" c="dimmed">
            点击上方表格中的股票查看 K 线（支持日线 / 4H / 1H）。
          </Text>
        </Card>
      )}
    </Stack>
  );
}
