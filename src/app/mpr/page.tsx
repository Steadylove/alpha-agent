import { Card } from "@/components/Card";
import { MprPanel } from "@/components/MprPanel";
import { MprTimeline } from "@/components/MprTimeline";
import { getMprData } from "@/lib/dashboard/mpr";
import { Group, Stack, Text } from "@mantine/core";

export const dynamic = "force-dynamic";

export default async function MprPage() {
  const data = await getMprData();

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-zinc-50">Market Phase Radar</h1>
        <span className="text-sm text-zinc-500">宏观相变雷达 · 日线</span>
      </div>

      <MprPanel data={data} />

      <MprTimeline history={data.history} />

      {data.latest ? (
        <Card
          title={
            <Stack gap={2}>
              <Text size="sm" fw={700} c="gray.1">
                移植校验
              </Text>
              <Text size="xs" c="dimmed">
                以下数值仅用于与 TradingView HUD 逐项比对，不作决策依据
              </Text>
            </Stack>
          }
        >
          <Stack gap={6}>
            <Group justify="space-between">
              <Text size="xs" c="dimmed">
                模型 5 日下跌概率（未校准）
              </Text>
              <Text size="xs" ff="monospace" c="gray.5">
                {data.latest.prob5dDown.toFixed(1)}%
              </Text>
            </Group>
            <Text size="xs" c="dimmed">
              3928 个交易日的回测显示该字段系统性高估约 2 倍（P2 报 79.9% 实为 38.0%，
              P4 报 84.1% 实为 37.9%，全样本基准 39.1%），因此不在主面板展示。
              保留它是为了核对 TypeScript 移植与 Pine 原版是否一致。
            </Text>
            <Text size="xs" c="dimmed">
              比对方法：TradingView 切到 SPY 日线挂上 MPR 指标，HUD 上的 F1~F5、Risk、
              期限比率、IEI/HYG 比率应与本页一致。先看两个原始比率——它们未经 ECDF，
              对不上说明是数据源差异而非移植错误。F1 依赖成交量口径，可能天然存在偏差。
            </Text>
          </Stack>
        </Card>
      ) : null}
    </div>
  );
}
