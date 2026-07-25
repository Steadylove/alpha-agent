"use client";

import { Card } from "@/components/Card";
import type { StockScore } from "@/lib/types/market";
import { Badge, Group, Stack, Text } from "@mantine/core";
import { Compass, Target } from "lucide-react";

/**
 * v3 白皮书核心概念：Dual-Target 双价格解耦
 *   PWFV = 长期公允价（是否值得持有）
 *   Trading Target = 60D 波段目标价（下一段行情空间）
 * 两者独立评估，各自对应 Valuation 的 10 分 + 10 分。
 */
export function DualTargetCards({ stock }: { stock: StockScore }) {
  const d = stock.details;
  const price = typeof d.tradingStopLoss === "number" && typeof d.stopLossRatio === "number"
    ? d.tradingStopLoss / (1 - d.stopLossRatio)
    : null;

  const pwfvFair = typeof d.pwfvFair === "number" ? d.pwfvFair : null;
  const pwfvMoS = typeof d.pwfvSafetyMargin === "number" ? d.pwfvSafetyMargin : null;
  const pwfvScore = typeof d.pwfvScore === "number" ? d.pwfvScore : 0;
  const pwfvSource = d.pwfvSource === "analyst-consensus" ? "分析师共识" : "动量兜底";

  const target60d = typeof d.tradingTarget60d === "number" ? d.tradingTarget60d : null;
  const stopLoss = typeof d.tradingStopLoss === "number" ? d.tradingStopLoss : null;
  const rrr = typeof d.rewardRiskRatio === "number" ? d.rewardRiskRatio : null;
  const rrrScore = typeof d.rrrScore === "number" ? d.rrrScore : 0;

  const upside60d = price != null && target60d != null ? (target60d - price) / price : null;

  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Card title={
        <Group gap="xs">
          <Compass className="h-4 w-4 text-blue-400" />
          <Text fw={600} c="gray.0">6-12M PWFV · 长期公允价</Text>
        </Group>
      }>
        <Stack gap="sm">
          <Group justify="space-between" align="baseline">
            <Text size="xl" fw={700} c="blue.4" ff="monospace">
              {pwfvFair != null ? `$${pwfvFair.toFixed(2)}` : "—"}
            </Text>
            <Badge color="blue" variant="light" radius="sm">
              MoS {pwfvScore}/10
            </Badge>
          </Group>
          <Group justify="space-between">
            <Text size="xs" c="dimmed">安全边际</Text>
            <Text size="sm" c={pwfvMoS != null && pwfvMoS >= 0 ? "teal.4" : "red.4"} fw={500} ff="monospace">
              {pwfvMoS != null ? `${pwfvMoS >= 0 ? "+" : ""}${(pwfvMoS * 100).toFixed(1)}%` : "—"}
            </Text>
          </Group>
          <Group justify="space-between">
            <Text size="xs" c="dimmed">Base 来源</Text>
            <Text size="xs" c="gray.3">{pwfvSource}</Text>
          </Group>
          <Group justify="space-between">
            <Text size="xs" c="dimmed">三档 (Bear / Base / Bull)</Text>
            <Text size="xs" c="gray.4" ff="monospace">
              {typeof d.pwfvBear === "number" ? `$${d.pwfvBear.toFixed(0)}` : "—"}
              {" / "}
              {typeof d.pwfvBase === "number" ? `$${d.pwfvBase.toFixed(0)}` : "—"}
              {" / "}
              {typeof d.pwfvBull === "number" ? `$${d.pwfvBull.toFixed(0)}` : "—"}
            </Text>
          </Group>
          <Text size="10px" c="dimmed" mt={4}>
            持有 6-12 月的价值锚点。加权 = 20% Bear + 55% Base + 25% Bull（分析师共识 ±25%）。
          </Text>
        </Stack>
      </Card>

      <Card title={
        <Group gap="xs">
          <Target className="h-4 w-4 text-cyan-400" />
          <Text fw={600} c="gray.0">60D Trading Target · 短期波段</Text>
        </Group>
      }>
        <Stack gap="sm">
          <Group justify="space-between" align="baseline">
            <Text size="xl" fw={700} c="cyan.4" ff="monospace">
              {target60d != null ? `$${target60d.toFixed(2)}` : "—"}
            </Text>
            <Badge color="cyan" variant="light" radius="sm">
              RRR {rrrScore}/10
            </Badge>
          </Group>
          <Group justify="space-between">
            <Text size="xs" c="dimmed">60D 潜在空间</Text>
            <Text size="sm" c={upside60d != null && upside60d >= 0 ? "teal.4" : "red.4"} fw={500} ff="monospace">
              {upside60d != null ? `${upside60d >= 0 ? "+" : ""}${(upside60d * 100).toFixed(1)}%` : "—"}
            </Text>
          </Group>
          <Group justify="space-between">
            <Text size="xs" c="dimmed">动态止损</Text>
            <Text size="xs" c="red.4" ff="monospace">
              {stopLoss != null ? `$${stopLoss.toFixed(2)}` : "—"}
            </Text>
          </Group>
          <Group justify="space-between">
            <Text size="xs" c="dimmed">R:R 盈亏比</Text>
            <Text size="sm" c={rrr != null && rrr >= 2 ? "teal.4" : rrr != null && rrr >= 1 ? "yellow.4" : "red.4"} fw={500} ff="monospace">
              {rrr != null ? rrr.toFixed(2) : "—"}
            </Text>
          </Group>
          <Text size="10px" c="dimmed" mt={4}>
            未来 60 交易日期望空间。Target = min(60D 阻力位, price + 1.5×ATR14×√60)，止损 = price − 2×ATR14。
          </Text>
        </Stack>
      </Card>
    </div>
  );
}
