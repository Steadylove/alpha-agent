"use client";

import { Card } from "@/components/Card";
import { DEFAULT_TRADE_PARAMS } from "@/lib/scoring/rotationTrade";
import type { RecentSignal } from "@/lib/dashboard/rotation";
import { Group, Stack, Text } from "@mantine/core";

const SIG_LABEL: Record<number, string> = { 1: "❤️ 一买", 2: "⭐️ 二买" };
const SIG_COLOR: Record<number, string> = { 1: "#ff4976", 2: "#fbbf24" };

export function RotationSignals({ signals }: { signals: RecentSignal[] }) {
  return (
    <Card
      title={
        <Stack gap={2}>
          <Text size="sm" fw={700} c="gray.1">
            近 30 日点火
          </Text>
          <Text size="xs" c="dimmed">
            对数 MACD 底背离触发点 · RS 低于 {DEFAULT_TRADE_PARAMS.minRs} 的不开仓
          </Text>
        </Stack>
      }
    >
      {signals.length === 0 ? (
        <Text size="sm" c="dimmed">
          近 30 日无点火信号。历史信号密度约 0.58%,长期空窗是常态。
        </Text>
      ) : (
        <Stack gap={6}>
          {signals.map((s) => {
            const gated = s.rs < DEFAULT_TRADE_PARAMS.minRs;
            return (
              <Group key={`${s.date}-${s.symbol}`} justify="space-between" wrap="nowrap">
                <Group gap="sm" wrap="nowrap">
                  <Text size="xs" c="dimmed" ff="monospace">
                    {s.date}
                  </Text>
                  <Text size="sm" fw={600} c="gray.1">
                    {s.symbol}
                  </Text>
                  <Text size="xs" fw={600} style={{ color: SIG_COLOR[s.sigType] }}>
                    {SIG_LABEL[s.sigType]}
                  </Text>
                </Group>
                <Group gap="md" wrap="nowrap">
                  <Text size="xs" ff="monospace" c="gray.4">
                    ${s.close.toFixed(2)}
                  </Text>
                  <Text size="xs" ff="monospace" c={gated ? "dimmed" : "gray.3"}>
                    RS {s.rs.toFixed(0)}
                  </Text>
                  {gated ? (
                    <Text size="xs" c="dimmed">
                      已过滤
                    </Text>
                  ) : null}
                </Group>
              </Group>
            );
          })}
        </Stack>
      )}
    </Card>
  );
}
