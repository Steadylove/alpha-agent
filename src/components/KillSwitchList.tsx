"use client";

import { Card } from "@/components/Card";
import type { StockScore } from "@/lib/types/market";
import { Alert, Badge, Group, Progress, Stack, Text } from "@mantine/core";
import { ShieldAlert, ShieldCheck } from "lucide-react";

/**
 * v3 白皮书模块零 · Kill Switch 展示区
 * 只在有 BLOCKED 名单时展示完整名单。始终展示通过率进度条。
 */
export function KillSwitchList({
  total,
  blocked,
}: {
  total: number;
  blocked: StockScore[];
}) {
  const passedCount = total - blocked.length;
  const passRate = total > 0 ? (passedCount / total) * 100 : 0;

  return (
    <Card
      title={
        <Group gap="xs">
          {blocked.length > 0 ? (
            <ShieldAlert className="h-4 w-4 text-red-400" />
          ) : (
            <ShieldCheck className="h-4 w-4 text-emerald-400" />
          )}
          <Text fw={600} c="gray.0">
            Kill Switch · 今日通过率 {passRate.toFixed(0)}%（{passedCount}/{total}）
          </Text>
          {blocked.length > 0 ? (
            <Badge color="red" size="sm" variant="filled">
              {blocked.length} 只熔断
            </Badge>
          ) : null}
        </Group>
      }
    >
      <Stack gap="sm">
        <Progress
          value={passRate}
          color={passRate >= 90 ? "teal" : passRate >= 70 ? "cyan" : passRate >= 50 ? "yellow" : "red"}
          radius="sm"
          size="sm"
        />
        {blocked.length === 0 ? (
          <Alert variant="light" color="teal" p="xs">
            <Text size="xs">
              全部候选股通过 6 条量化熔断（反向拆股 / 市值 / ADTV / 稀释 / GM 环降 / 单日 &gt;30%）。市场结构健康。
            </Text>
          </Alert>
        ) : (
          <Stack gap={4}>
            {blocked.slice(0, 8).map((s) => (
              <Group key={s.symbol} justify="space-between" wrap="nowrap">
                <Group gap={6} wrap="nowrap">
                  <Text size="sm" fw={600} c="red.4" ff="monospace">
                    ⛔ {s.symbol}
                  </Text>
                  <Text size="xs" c="dimmed" lineClamp={1}>
                    {s.name}
                  </Text>
                </Group>
                <Text size="xs" c="gray.4" style={{ textAlign: "right" }}>
                  {s.killSwitchReason ?? "-"}
                </Text>
              </Group>
            ))}
            {blocked.length > 8 ? (
              <Text size="xs" c="dimmed" ta="center" mt={4}>
                还有 {blocked.length - 8} 只未列出
              </Text>
            ) : null}
          </Stack>
        )}
      </Stack>
    </Card>
  );
}
