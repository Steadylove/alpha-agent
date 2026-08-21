"use client";

import { Card } from "@/components/Card";
import type { MacroPhaseSnapshot } from "@/lib/dashboard/mpr";
import { Group, Stack, Text } from "@mantine/core";
import { useState } from "react";

/** 与 MprPanel 保持一致的路径配色。 */
const PATH_COLOR: Record<number, string> = {
  0: "#10b981",
  1: "#f59e0b",
  2: "#f97316",
  3: "#eab308",
  4: "#ef4444",
};

const PATH_LABEL: Record<number, string> = {
  0: "P0 稳态自洽",
  1: "P1 跨市场暗流",
  2: "P2 相变扩散",
  3: "P3 微观漂移",
  4: "P4 破位确认",
};

export function MprTimeline({ history }: { history: MacroPhaseSnapshot[] }) {
  const [hovered, setHovered] = useState<number | null>(null);

  if (history.length === 0) return null;

  const active = hovered == null ? history[history.length - 1] : history[hovered];
  const counts = new Map<number, number>();
  for (const day of history) counts.set(day.pathId, (counts.get(day.pathId) ?? 0) + 1);

  return (
    <Card
      title={
        <Stack gap={2}>
          <Text size="sm" fw={700} c="gray.1">
            路径与风险分历史
          </Text>
          <Text size="xs" c="dimmed">
            近 {history.length} 个交易日 · 柱高为风险分，颜色为传导路径
          </Text>
        </Stack>
      }
      action={
        <Group gap="md">
          <Text size="xs" ff="monospace" c="gray.3">
            {active.date}
          </Text>
          <Text size="xs" fw={600} style={{ color: PATH_COLOR[active.pathId] }}>
            {PATH_LABEL[active.pathId]}
          </Text>
          <Text size="xs" ff="monospace" c="gray.3">
            Risk {active.marketRiskScore.toFixed(0)}
          </Text>
        </Group>
      }
    >
      <Stack gap="sm">
        <div
          className="flex h-24 items-end gap-px"
          onMouseLeave={() => setHovered(null)}
          role="img"
          aria-label="MPR 路径与风险分历史"
        >
          {history.map((day, index) => (
            <button
              key={day.date}
              type="button"
              onMouseEnter={() => setHovered(index)}
              onFocus={() => setHovered(index)}
              title={`${day.date} · ${PATH_LABEL[day.pathId]} · Risk ${day.marketRiskScore.toFixed(0)}`}
              className="min-w-0 flex-1 cursor-default rounded-sm p-0 transition-opacity hover:opacity-100"
              style={{
                height: `${Math.max(4, day.marketRiskScore)}%`,
                backgroundColor: PATH_COLOR[day.pathId],
                opacity: hovered == null || hovered === index ? 1 : 0.45,
                border: "none",
              }}
            />
          ))}
        </div>

        <Group justify="space-between">
          <Text size="xs" c="dimmed" ff="monospace">
            {history[0].date}
          </Text>
          <Text size="xs" c="dimmed" ff="monospace">
            {history[history.length - 1].date}
          </Text>
        </Group>

        <Group gap="lg" wrap="wrap">
          {[0, 1, 2, 3, 4].map((pathId) => {
            const count = counts.get(pathId) ?? 0;
            return (
              <Group key={pathId} gap={6}>
                <span
                  className="inline-block h-2 w-2 rounded-sm"
                  style={{ backgroundColor: PATH_COLOR[pathId] }}
                />
                <Text size="xs" c="dimmed">
                  {PATH_LABEL[pathId]}
                </Text>
                <Text size="xs" c="gray.3" ff="monospace">
                  {count} 天 · {((count / history.length) * 100).toFixed(0)}%
                </Text>
              </Group>
            );
          })}
        </Group>
      </Stack>
    </Card>
  );
}
