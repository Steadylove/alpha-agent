"use client";

import { Card } from "@/components/Card";
import { signalLabel, starsFromScore } from "@/lib/scoring/format";
import type { StockScore } from "@/lib/types/market";
import {
  Alert,
  Group,
  Popover,
  Progress,
  RingProgress,
  SimpleGrid,
  Stack,
  Text,
  UnstyledButton,
} from "@mantine/core";
import { AlertTriangle, ChevronDown, ShieldAlert } from "lucide-react";
import type { ReactNode } from "react";

type Details = StockScore["details"];

type Dim = {
  key: keyof Pick<
    StockScore,
    "momentumScore" | "trendScore" | "fundamentalScore" | "valuationScore" | "environmentScore" | "executionScore"
  >;
  label: string;
  desc: string;
  max: number;
  vetoWhenZero?: boolean;
  explain: (details: Details) => ReactNode;
};

const num = (v: number | string | boolean | null | undefined, digits = 2) =>
  typeof v === "number" ? v.toFixed(digits) : "N/A";
const pct = (v: number | string | boolean | null | undefined, digits = 1) =>
  typeof v === "number" ? `${(v * 100).toFixed(digits)}%` : "N/A";

const Row = ({ label, value }: { label: string; value: ReactNode }) => (
  <Group justify="space-between">
    <Text size="xs" c="dimmed">
      {label}
    </Text>
    <Text size="xs" c="gray.2" fw={500} ff="monospace">
      {value}
    </Text>
  </Group>
);

const DIMENSIONS: Dim[] = [
  {
    key: "momentumScore",
    label: "Momentum 动量质量",
    desc: "多周期 RPS 8 + 加速度 4 + Event Ratio 3（防脉冲）",
    max: 15,
    explain: (d) => (
      <Stack gap={4}>
        <Row label="21D 百分位" value={num(d.rps21, 0)} />
        <Row label="63D 百分位" value={num(d.rps63, 0)} />
        <Row label="252D 百分位" value={num(d.rps252, 0)} />
        <Row label="加权 RPS" value={num(d.weightedRps, 0)} />
        <Row label="加速度 (rps21 - rps63)" value={num(d.acceleration, 0)} />
        <Row
          label="Event Ratio"
          value={
            typeof d.eventRatio === "number"
              ? `${d.eventRatio.toFixed(2)}${d.eventRatio > 3 ? " ⛔" : ""}`
              : "N/A"
          }
        />
        <Text size="10px" c="dimmed">
          规则：Event Ratio &gt;3 → 事件脉冲 0 分；&gt;2 → 1 分；≤2 → 3 分
        </Text>
      </Stack>
    ),
  },
  {
    key: "trendScore",
    label: "Trend 趋势结构",
    desc: "均线+新高 4 + Up Day Ratio 3 + 回撤健康度 3",
    max: 10,
    explain: (d) => (
      <Stack gap={4}>
        <Row label="Close &gt; MA20 &gt; MA50 &gt; MA200" value={d.stackedMa ? "✅ +2" : "❌ 0"} />
        <Row
          label="距 52 周新高"
          value={typeof d.proximityToHigh === "number" ? pct(d.proximityToHigh, 1) : "N/A"}
        />
        <Row
          label="63D 上涨天数比"
          value={typeof d.upDayRatio63 === "number" ? pct(d.upDayRatio63, 0) : "N/A"}
        />
        <Row
          label="3M 最大回撤"
          value={typeof d.drawdown3m === "number" ? pct(d.drawdown3m, 1) : "N/A"}
        />
        <Text size="10px" c="dimmed">
          Up Day Ratio ≥60% → +3；回撤 ≤8% → +3（越平滑越好）
        </Text>
      </Stack>
    ),
  },
  {
    key: "fundamentalScore",
    label: "Fundamental 基本面质量",
    desc: "Growth 8 + Profit 7 + Revisions 5 + Moat 5",
    max: 25,
    vetoWhenZero: true,
    explain: (d) => (
      <Stack gap={4}>
        {!d.hasFundamentalData ? (
          <Text size="xs" c="yellow.4">
            ⚠️ FMP 未返回基本面数据（可能 401 或超时），全维度默认 0 分。
          </Text>
        ) : null}
        {d.fundamentalVetoed ? (
          <Text size="xs" c="red.4">
            ⛔ EPS Revision &lt; -10%，一票否决归 0。
          </Text>
        ) : null}
        <Row label="Growth 分" value={`${num(d.growthScore, 0)} / 8`} />
        <Row label="Profit 分" value={`${num(d.profitScore, 0)} / 7`} />
        <Row label="Revisions 分" value={`${num(d.revisionScore, 0)} / 5`} />
        <Row
          label={`Moat 分（${d.moatSource === "llm" ? "LLM" : "兜底 3"}）`}
          value={`${num(d.moatScore, 0)} / 5`}
        />
        {typeof d.moatReason === "string" && d.moatReason ? (
          <Text size="10px" c="grape.3" mt={2}>
            🧠 {d.moatReason}
          </Text>
        ) : null}
        <Row
          label="NTM Revenue YoY"
          value={typeof d.revenueGrowth === "number" ? pct(d.revenueGrowth, 1) : "N/A"}
        />
        <Row
          label="Gross Margin"
          value={typeof d.grossMargin === "number" ? pct(d.grossMargin, 1) : "N/A"}
        />
        <Row
          label="ROIC"
          value={typeof d.roic === "number" ? pct(d.roic, 1) : "N/A"}
        />
        <Row
          label="EPS Revision"
          value={typeof d.epsRevision === "number" ? pct(d.epsRevision, 1) : "N/A"}
        />
      </Stack>
    ),
  },
  {
    key: "valuationScore",
    label: "Valuation 估值赔率",
    desc: "6-12M PWFV MoS 10 + 60D RRR 10",
    max: 20,
    explain: (d) => (
      <Stack gap={4}>
        <Text size="10px" c="dimmed">
          Base 用分析师 12M 共识 ±25% 撑起 Bear/Bull；权重 20/55/25
        </Text>
        <Row
          label="PWFV Base"
          value={typeof d.pwfvBase === "number" ? `$${num(d.pwfvBase, 2)}` : "N/A"}
        />
        <Row
          label="加权公允价"
          value={typeof d.pwfvFair === "number" ? `$${num(d.pwfvFair, 2)}` : "N/A"}
        />
        <Row
          label="安全边际"
          value={typeof d.pwfvSafetyMargin === "number" ? pct(d.pwfvSafetyMargin, 1) : "N/A"}
        />
        <Row label="MoS 分" value={`${num(d.pwfvScore, 0)} / 10`} />
        <Row
          label="60D 目标价"
          value={typeof d.tradingTarget60d === "number" ? `$${num(d.tradingTarget60d, 2)}` : "N/A"}
        />
        <Row
          label="R:R"
          value={typeof d.rewardRiskRatio === "number" ? num(d.rewardRiskRatio, 2) : "N/A"}
        />
        <Row label="RRR 分" value={`${num(d.rrrScore, 0)} / 10`} />
        {d.pwfvSource === "fallback-momentum" ? (
          <Text size="10px" c="yellow.4">
            ⚠️ 无分析师目标价，Base 用动量兜底
          </Text>
        ) : null}
      </Stack>
    ),
  },
  {
    key: "environmentScore",
    label: "Environment 市场环境",
    desc: "MSS 5 + Breadth 5 + Credit 5（全市场共享）",
    max: 15,
    explain: (d) => (
      <Stack gap={4}>
        <Row label="MSS（尾部 + 风险偏好归一）" value={`${num(d.envMss, 0)} / 5`} />
        <Row label="Breadth（50D 站上比）" value={`${num(d.envBreadth, 0)} / 5`} />
        <Row label="Credit（HYG-TLT 相对）" value={`${num(d.envCredit, 0)} / 5`} />
        <Text size="10px" c="dimmed">
          所有股票拿到相同的 Environment 分，用于全市场基线
        </Text>
      </Stack>
    ),
  },
  {
    key: "executionScore",
    label: "Execution 执行买点",
    desc: "GBZ 位置 8 + Selling Pressure 4 + 止损比 3",
    max: 15,
    explain: (d) => (
      <Stack gap={4}>
        <Row label="GBZ 位置分" value={`${num(d.gbzZoneScore, 0)} / 8`} />
        <Row
          label="距 GBZ 中枢"
          value={typeof d.distanceToGbz === "number" ? pct(d.distanceToGbz, 2) : "N/A"}
        />
        <Row label="Selling Pressure 分" value={`${num(d.sellingPressureScore, 0)} / 4`} />
        <Row
          label="20D Selling Pressure"
          value={typeof d.sellingPressure20d === "number" ? pct(d.sellingPressure20d, 1) : "N/A"}
        />
        <Row label="止损比分" value={`${num(d.stopRatioScore, 0)} / 3`} />
        <Row
          label="止损空间"
          value={typeof d.stopLossRatio === "number" ? pct(d.stopLossRatio, 1) : "N/A"}
        />
        <Text size="10px" c="dimmed">
          回踩 GBZ + 缩量 (SP&lt;35%) + 止损 ≤8% → 满 15
        </Text>
      </Stack>
    ),
  },
];

const barColor = (value: number, max: number, veto: boolean) => {
  if (veto) return "red";
  const p = value / max;
  if (p >= 0.8) return "teal";
  if (p >= 0.5) return "cyan";
  if (p >= 0.2) return "yellow";
  return "gray";
};

const scoreColor = (score: number) => {
  if (score >= 80) return "teal";
  if (score >= 60) return "cyan";
  if (score >= 40) return "yellow";
  return "red";
};

function ExpandRow({ trigger, dropdown }: { trigger: ReactNode; dropdown: ReactNode }) {
  return (
    <Popover position="bottom-start" withArrow shadow="md" width={340} radius="md">
      <Popover.Target>
        <UnstyledButton className="w-full">{trigger}</UnstyledButton>
      </Popover.Target>
      <Popover.Dropdown>{dropdown}</Popover.Dropdown>
    </Popover>
  );
}

export function StockScoreCard({ stock }: { stock: StockScore }) {
  const finalMeta = scoreColor(stock.finalCompassScore);
  const stars = starsFromScore(stock.finalCompassScore);
  const label = signalLabel(stock.finalCompassScore);
  const isBlocked = stock.killSwitchStatus === "BLOCKED";

  const vetos: string[] = [];
  DIMENSIONS.forEach((d) => {
    if (d.vetoWhenZero && stock[d.key] === 0) {
      vetos.push(d.label);
    }
  });

  return (
    <Card title="Signal Attribution 归因（Final Compass Score 六维打分）">
      {isBlocked ? (
        <Alert
          color="red"
          variant="filled"
          icon={<ShieldAlert size={16} />}
          title="Kill Switch 熔断触发"
          mb="md"
        >
          <Text size="sm" c="white">
            {stock.killSwitchReason ?? "未通过入选前置过滤"}。Final Compass Score 归 0，不参与排名。
          </Text>
        </Alert>
      ) : null}

      <SimpleGrid cols={{ base: 1, md: 3 }} spacing="md">
        <Popover position="right" withArrow shadow="md" width={300} radius="md">
          <Popover.Target>
            <UnstyledButton>
              <Stack gap={4} align="center" justify="center">
                <RingProgress
                  size={140}
                  thickness={12}
                  roundCaps
                  sections={[{ value: stock.finalCompassScore, color: finalMeta }]}
                  label={
                    <Stack gap={0} align="center">
                      <Text size="2rem" fw={600} c="gray.0" lh={1}>
                        {stock.finalCompassScore}
                      </Text>
                      <Text size="xs" c="dimmed">
                        Final Compass
                      </Text>
                    </Stack>
                  }
                />
                <Text size="sm" c={`${finalMeta}.4`} fw={500}>
                  {stars} {label}
                </Text>
              </Stack>
            </UnstyledButton>
          </Popover.Target>
          <Popover.Dropdown>
            <Stack gap={4}>
              <Text size="xs" c="dimmed" fw={600}>
                v3 Final Compass Score = 四大加权 (max 100)
              </Text>
              <Row label="股票质量 (50%)" value={`${stock.qualityScore} / 50`} />
              <Row label="  └ Momentum" value={`${stock.momentumScore} / 15`} />
              <Row label="  └ Trend" value={`${stock.trendScore} / 10`} />
              <Row label="  └ Fundamental" value={`${stock.fundamentalScore} / 25`} />
              <Row label="估值赔率 (20%)" value={`${stock.valuationScore} / 20`} />
              <Row label="市场环境 (15%)" value={`${stock.environmentScore} / 15`} />
              <Row label="执行买点 (15%)" value={`${stock.executionScore} / 15`} />
              <Row label="Total" value={`${stock.finalCompassScore} / 100`} />
              <Text size="10px" c="dimmed" mt={4}>
                信号级别：≥90 强关注 ｜ ≥80 低吸 ｜ ≥70 观察 ｜ &lt;70 风险偏高
              </Text>
            </Stack>
          </Popover.Dropdown>
        </Popover>

        <Stack gap="sm" style={{ gridColumn: "span 2" }}>
          {DIMENSIONS.map((d) => {
            const value = stock[d.key];
            const veto = !!d.vetoWhenZero && value === 0 && !isBlocked;
            const barPct = (value / d.max) * 100;
            return (
              <ExpandRow
                key={d.key}
                trigger={
                  <Stack
                    gap={2}
                    className="rounded px-2 py-1 -mx-2 hover:bg-zinc-900 transition-colors"
                  >
                    <Group justify="space-between" wrap="nowrap">
                      <Group gap="xs" wrap="nowrap">
                        <Text size="sm" c="gray.2" fw={500}>
                          {d.label}
                        </Text>
                        {veto ? (
                          <Text size="xs" c="red.4" fw={600}>
                            ⛔ 一票否决
                          </Text>
                        ) : null}
                        <ChevronDown className="h-3 w-3 text-zinc-500" />
                      </Group>
                      <Text size="sm" c={`${barColor(value, d.max, veto)}.4`} fw={500}>
                        {value} / {d.max}
                      </Text>
                    </Group>
                    <Progress
                      value={barPct}
                      color={barColor(value, d.max, veto)}
                      radius="sm"
                      size="md"
                    />
                    <Text size="xs" c="dimmed">
                      {d.desc}
                    </Text>
                  </Stack>
                }
                dropdown={
                  <Stack gap={4}>
                    <Text size="xs" c="dimmed" fw={600}>
                      {d.label} · 计算拆解
                    </Text>
                    {d.explain(stock.details)}
                  </Stack>
                }
              />
            );
          })}
        </Stack>
      </SimpleGrid>

      {vetos.length > 0 && !isBlocked ? (
        <Alert
          mt="md"
          color="red"
          variant="light"
          icon={<AlertTriangle size={16} />}
          title="维度归零"
        >
          <Text size="sm">
            以下维度归零：<Text component="span" fw={600}>{vetos.join(" / ")}</Text>
            。EPS Revision 大幅下调或基本面数据缺失时该维直接归 0。
          </Text>
        </Alert>
      ) : null}
    </Card>
  );
}
