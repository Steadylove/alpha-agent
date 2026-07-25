"use client";

import { Card } from "@/components/Card";
import { starsFromScore } from "@/lib/scoring/format";
import type { MarketMetric, SectorScore, StockScore } from "@/lib/types/market";
import {
  Group,
  Popover,
  Progress,
  RingProgress,
  SimpleGrid,
  Stack,
  Text,
  UnstyledButton,
} from "@mantine/core";
import Link from "next/link";
import type { ReactNode } from "react";

const regimeMeta = (mss: number) => {
  if (mss >= 75) return { label: "Risk-On", color: "teal", hex: "#10b981" };
  if (mss >= 50) return { label: "Neutral", color: "yellow", hex: "#f59e0b" };
  return { label: "Risk-Off", color: "red", hex: "#ef4444" };
};

const factorColor = (score: number | null, thresholds: { good: number; ok: number }) => {
  if (score == null) return "gray";
  if (score >= thresholds.good) return "teal";
  if (score >= thresholds.ok) return "yellow";
  return "red";
};

type FactorDef = {
  key: "creditScore" | "pcrScore" | "breadthScore" | "skewScore";
  label: string;
  source: string;
  rule: string;
  thresholds: { good: number; ok: number };
};

const FACTORS: FactorDef[] = [
  {
    key: "creditScore",
    label: "流动性 (Credit)",
    source: "HYG − TLT 21D 相对收益",
    rule: "> -2% → 25 ｜ 否则 0（信用利差走阔警报）",
    thresholds: { good: 20, ok: 10 },
  },
  {
    key: "pcrScore",
    label: "风险偏好 (PCR/VIX)",
    source: "CBOE VIX",
    rule: "<18 → 25 ｜ 18-25 → 15 ｜ 25-35 → 10 ｜ >35 → 0",
    thresholds: { good: 20, ok: 10 },
  },
  {
    key: "breadthScore",
    label: "市场宽度 (Breadth)",
    source: "SP500 中站上 50 日线的股票比例",
    rule: ">60% → 25 ｜ 40-60% → 15 ｜ <40% → 0",
    thresholds: { good: 20, ok: 12 },
  },
  {
    key: "skewScore",
    label: "尾部风险 (SKEW)",
    source: "CBOE SKEW Index",
    rule: "<130 → 25 ｜ 130-145 → 15 ｜ >145 → 0（机构囤 Put）",
    thresholds: { good: 20, ok: 12 },
  },
];

function FactorBar({
  factor,
  score,
}: {
  factor: FactorDef;
  score: number | null;
}) {
  const value = score ?? 0;
  const pct = (value / 25) * 100;
  return (
    <Popover position="right" withArrow shadow="md" width={280} radius="md">
      <Popover.Target>
        <UnstyledButton className="w-full">
          <Stack gap={4} className="rounded px-2 py-1 -mx-2 hover:bg-zinc-900 transition-colors">
            <Group justify="space-between">
              <Text size="xs" c="dimmed">
                {factor.label}
              </Text>
              <Text size="xs" c="gray.2" fw={500}>
                {score == null ? "N/A" : `${score}/25`}
              </Text>
            </Group>
            <Progress value={pct} color={factorColor(score, factor.thresholds)} radius="sm" size="sm" />
          </Stack>
        </UnstyledButton>
      </Popover.Target>
      <Popover.Dropdown>
        <Stack gap={4}>
          <Text size="xs" c="dimmed" fw={600}>
            {factor.label}
          </Text>
          <Text size="xs" c="gray.2">
            <b>数据源：</b>
            {factor.source}
          </Text>
          <Text size="xs" c="gray.2">
            <b>打分规则：</b>
            {factor.rule}
          </Text>
          <Text size="xs" c="gray.2">
            <b>当前得分：</b>
            {score == null ? "N/A（数据缺失）" : `${score}/25`}
          </Text>
        </Stack>
      </Popover.Dropdown>
    </Popover>
  );
}

function ClickPopover({
  trigger,
  children,
}: {
  trigger: ReactNode;
  children: ReactNode;
}) {
  return (
    <Popover position="bottom-start" withArrow shadow="md" width={320} radius="md">
      <Popover.Target>
        <UnstyledButton className="w-full">{trigger}</UnstyledButton>
      </Popover.Target>
      <Popover.Dropdown>{children}</Popover.Dropdown>
    </Popover>
  );
}

export function ReportHud({
  marketMetric,
  sectors,
  stocks,
  reportDate,
}: {
  marketMetric: MarketMetric | null;
  sectors: SectorScore[];
  stocks: StockScore[];
  reportDate: string;
}) {
  const mss = marketMetric?.mss ?? 0;
  const meta = regimeMeta(mss);
  const topSectors = sectors.slice(0, 3);
  const topStocks = stocks.slice(0, 5);
  const sectorMax = Math.max(...topSectors.map((s) => s.score), 100);

  return (
    <SimpleGrid cols={{ base: 1, lg: 2 }} spacing="md">
      <Card title="Market Regime · 点击环形/因子看公式">
        <Group align="flex-start" wrap="nowrap" gap="lg">
          <ClickPopover
            trigger={
              <RingProgress
                size={120}
                thickness={10}
                roundCaps
                sections={[{ value: mss, color: meta.color }]}
                label={
                  <Stack gap={0} align="center">
                    <Text size="1.75rem" fw={600} c="gray.0" lh={1}>
                      {mss}
                    </Text>
                    <Text size="xs" c="dimmed">
                      MSS
                    </Text>
                  </Stack>
                }
              />
            }
          >
            <Stack gap={4}>
              <Text size="xs" c="dimmed" fw={600}>
                MSS = 流动性 + 风险偏好 + 宽度 + 尾部（各 25 分）
              </Text>
              <Group justify="space-between">
                <Text size="xs" c="gray.2">
                  流动性
                </Text>
                <Text size="xs" ff="monospace">
                  {marketMetric?.creditScore ?? "N/A"} / 25
                </Text>
              </Group>
              <Group justify="space-between">
                <Text size="xs" c="gray.2">
                  风险偏好
                </Text>
                <Text size="xs" ff="monospace">
                  {marketMetric?.pcrScore ?? "N/A"} / 25
                </Text>
              </Group>
              <Group justify="space-between">
                <Text size="xs" c="gray.2">
                  市场宽度
                </Text>
                <Text size="xs" ff="monospace">
                  {marketMetric?.breadthScore ?? "N/A"} / 25
                </Text>
              </Group>
              <Group justify="space-between">
                <Text size="xs" c="gray.2">
                  尾部风险
                </Text>
                <Text size="xs" ff="monospace">
                  {marketMetric?.skewScore ?? "N/A"} / 25
                </Text>
              </Group>
              <Group justify="space-between">
                <Text size="xs" c="gray.2" fw={600}>
                  合计 MSS
                </Text>
                <Text size="xs" ff="monospace" fw={600}>
                  {mss} / 100
                </Text>
              </Group>
              <Text size="10px" c="dimmed" mt={4}>
                置信度 {Math.round((marketMetric?.confidence ?? 0) * 100)}%，缺失因子按等比放大。
              </Text>
            </Stack>
          </ClickPopover>
          <Stack gap="xs" style={{ flex: 1, minWidth: 0 }}>
            <Group gap="xs">
              <Text size="sm" fw={500} c={`${meta.color}.4`}>
                {meta.label}
              </Text>
              <Text size="xs" c="dimmed">
                置信度 {Math.round((marketMetric?.confidence ?? 0) * 100)}%
              </Text>
            </Group>
            {FACTORS.map((f) => (
              <FactorBar key={f.key} factor={f} score={marketMetric?.[f.key] ?? null} />
            ))}
          </Stack>
        </Group>
      </Card>

      <Card title="Sector & Alpha （点击 Sector 看 RS 公式）">
        <Stack gap="md">
          <Stack gap={6}>
            <Text size="xs" c="dimmed" tt="uppercase" fw={600}>
              🔄 Sector Top 3
            </Text>
            {topSectors.map((sector, idx) => {
              const medal = idx === 0 ? "🥇" : idx === 1 ? "🥈" : "🥉";
              return (
                <ClickPopover
                  key={sector.symbol}
                  trigger={
                    <Stack gap={2} className="rounded px-2 py-1 -mx-2 hover:bg-zinc-900 transition-colors">
                      <Group justify="space-between">
                        <Text size="sm" c="gray.2">
                          {medal} {sector.name}
                        </Text>
                        <Text size="sm" c="cyan.4" fw={500}>
                          {sector.score}
                        </Text>
                      </Group>
                      <Progress
                        value={(sector.score / sectorMax) * 100}
                        color="cyan"
                        radius="sm"
                        size="sm"
                      />
                    </Stack>
                  }
                >
                  <Stack gap={4}>
                    <Text size="xs" c="dimmed" fw={600}>
                      {sector.name} ({sector.symbol}) · RS 打分
                    </Text>
                    <Text size="xs" c="gray.2">
                      Score = 50 × rs21_percentile + 50 × rs63_percentile
                    </Text>
                    <Group justify="space-between">
                      <Text size="xs" c="dimmed">
                        rs21 (超 SPY)
                      </Text>
                      <Text size="xs" ff="monospace">
                        {(sector.rs21 * 100).toFixed(2)}%
                      </Text>
                    </Group>
                    <Group justify="space-between">
                      <Text size="xs" c="dimmed">
                        rs63 (超 SPY)
                      </Text>
                      <Text size="xs" ff="monospace">
                        {(sector.rs63 * 100).toFixed(2)}%
                      </Text>
                    </Group>
                    <Group justify="space-between">
                      <Text size="xs" c="dimmed">
                        Sector Score
                      </Text>
                      <Text size="xs" ff="monospace" fw={600}>
                        {sector.score}
                      </Text>
                    </Group>
                    <Text size="10px" c="dimmed" mt={4}>
                      Top 3 板块中的股票在 Stock Score 中获 +15 分。
                    </Text>
                  </Stack>
                </ClickPopover>
              );
            })}
          </Stack>

          <Stack gap={4}>
            <Text size="xs" c="dimmed" tt="uppercase" fw={600}>
              🚀 Alpha Top 5
            </Text>
            {topStocks.map((stock) => (
              <Link
                key={stock.symbol}
                href={`/stock/${stock.symbol}`}
                className="flex items-center justify-between text-sm hover:bg-zinc-900 rounded px-1 -mx-1 transition-colors"
              >
                <Group gap="xs">
                  <Text size="sm" c="gray.2" fw={500}>
                    {stock.symbol}
                  </Text>
                  <Text size="xs" c="dimmed">
                    {starsFromScore(stock.finalCompassScore)}
                  </Text>
                </Group>
                <Text size="sm" c="emerald.4" fw={500}>
                  {stock.finalCompassScore}
                </Text>
              </Link>
            ))}
          </Stack>
        </Stack>
      </Card>

      <Text size="xs" c="dimmed" ta="right" style={{ gridColumn: "1 / -1" }}>
        Report {reportDate} · 点击环/进度条查看公式，跳转{" "}
        <Link href="/methodology" className="underline hover:text-zinc-200">
          Methodology
        </Link>{" "}
        看全流程
      </Text>
    </SimpleGrid>
  );
}
