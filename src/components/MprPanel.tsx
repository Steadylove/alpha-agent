"use client";

import { Card } from "@/components/Card";
import type { MacroPhaseSnapshot } from "@/lib/dashboard/mpr";
import { MPR_PATH_LABEL, macroPhaseReading } from "@/lib/scoring/mprReading";
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
import type { ReactNode } from "react";

/** 与 Pine 的 state_color 对应：S0 绿 / S1 黄 / S2 橙 / S3 红。 */
const STATE_META: Record<number, { label: string; color: string }> = {
  0: { label: "S0 环境安静", color: "teal" },
  1: { label: "S1 局部异动", color: "yellow" },
  2: { label: "S2 压力扩散", color: "orange" },
  3: { label: "S3 高波动", color: "red" },
};

const PATH_META: Record<number, { color: string; note: string }> = {
  0: {
    color: "teal",
    note: "兜底分支。原版判定树在此处有覆盖空洞，破坏度落在 60~70 且三域承压时也会落到这里，不等于「安全」。",
  },
  1: {
    color: "yellow",
    note: "衍生品或信用域异动、现货尚未反应。历史校准显示该路径后续 5 日下跌频率 29.1%，低于 39.1% 的基准，并非看空。",
  },
  2: {
    color: "orange",
    note: "压力已扩散至现货。占全部交易日 35.3%，触发过于频繁，历史下跌频率 38.0% 与基准无异。",
  },
  3: { color: "yellow", note: "仅现货域异动，衍生品与信用域平静。" },
  4: {
    color: "red",
    note: "唯一有统计意义的路径：后续 5 日跌幅超 3% 的概率 11.9%，约为其他路径的 3~4 倍。同时平均收益也最高（+0.59%），是高波动区制，不是看跌。",
  },
};

type ForceDef = {
  key: "f1" | "f2" | "f3" | "f4" | "f5";
  label: string;
  source: string;
  hint: (day: MacroPhaseSnapshot) => string;
  raw?: (day: MacroPhaseSnapshot) => string;
};

const FORCES: ForceDef[] = [
  {
    key: "f1",
    label: "F1 量价推进效率",
    source: "SPY 价格位置 × 成交量效率",
    hint: (d) => (d.f1 > 75 ? "高位放量滞涨 / 主力派发" : "量价推进效率正常"),
  },
  {
    key: "f2",
    label: "F2 隐波期限结构",
    source: "VIX9D / VIX3M（VIX<16 或比率<0.9 时压制至 45）",
    hint: (d) => (d.f2 > 75 ? "短端隐波翘头 / 期权倒挂" : "隐波期限结构正常"),
    raw: (d) => `9D/3M 期限比率 ${d.rawTerm.toFixed(2)}`,
  },
  {
    key: "f3",
    label: "F3 跨资产避险脱节",
    source: "SPY 下跌时 TLT / DXY 的避险买盘",
    hint: (d) => (d.f3 > 75 ? "避险资产（美债/美元）异常走强" : "跨资产逻辑自洽"),
  },
  {
    key: "f4",
    label: "F4 信用利差紧缩",
    source: "IEI / HYG 比价",
    hint: (d) => (d.f4 > 75 ? "高收益债抛售 / 利差走阔" : "机构信用流动性充沛"),
    raw: (d) => `IEI/HYG 比率 ${d.rawCred.toFixed(2)}`,
  },
  {
    key: "f5",
    label: "F5 现货广度背离",
    source: "SPY − RSP 的 5 日收益差",
    hint: (d) => (d.f5 > 75 ? "权重巨头掩护 / 广度严重失血" : "全市场普涨健康均衡"),
  },
];

const forceColor = (value: number) => {
  if (value >= 75) return "red";
  if (value >= 50) return "orange";
  if (value >= 25) return "yellow";
  return "teal";
};

const riskColor = (score: number) => {
  if (score >= 75) return "red";
  if (score >= 50) return "orange";
  if (score >= 25) return "yellow";
  return "teal";
};

function ClickPopover({ trigger, children }: { trigger: ReactNode; children: ReactNode }) {
  return (
    <Popover position="bottom-start" withArrow shadow="md" width={340} radius="md">
      <Popover.Target>
        <UnstyledButton className="w-full">{trigger}</UnstyledButton>
      </Popover.Target>
      <Popover.Dropdown>{children}</Popover.Dropdown>
    </Popover>
  );
}

function ForceBar({ force, day }: { force: ForceDef; day: MacroPhaseSnapshot }) {
  const value = day[force.key];
  return (
    <ClickPopover
      trigger={
        <Stack gap={4} className="rounded px-2 py-1 -mx-2 hover:bg-[var(--surface-hover)] transition-colors">
          <Group justify="space-between">
            <Text size="xs" c="dimmed">
              {force.label}
            </Text>
            <Text size="xs" c="gray.2" fw={500} ff="monospace">
              {value.toFixed(1)}%
            </Text>
          </Group>
          <Progress value={value} color={forceColor(value)} radius="sm" size="sm" />
        </Stack>
      }
    >
      <Stack gap={4}>
        <Text size="xs" c="dimmed" fw={600}>
          {force.label}
        </Text>
        <Text size="xs" c="gray.2">
          <b>数据源：</b>
          {force.source}
        </Text>
        {force.raw ? (
          <Text size="xs" c="gray.2">
            <b>原始值：</b>
            {force.raw(day)}
          </Text>
        ) : null}
        <Text size="xs" c="gray.2">
          <b>当前分位：</b>
          {value.toFixed(1)}%（在过去一年中的排位）
        </Text>
        <Text size="xs" c="gray.2">
          <b>解读：</b>
          {force.hint(day)}
        </Text>
      </Stack>
    </ClickPopover>
  );
}

/** Pine 的 σ 分级：压力分位跨过 50 记异动、跨过 75 记极端。 */
const SIGMA_LABEL: Record<number, string> = { 0: "静", 1: "异动", 2: "极端" };

function Stat({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <Group justify="space-between">
      <Text size="xs" c="dimmed">
        {label}
      </Text>
      <Text size="xs" ff="monospace" c={color ?? "gray.2"} fw={500}>
        {value}
      </Text>
    </Group>
  );
}

export function MprPanel({
  data,
}: {
  data: { latest: MacroPhaseSnapshot | null; missingSymbols: string[] };
}) {
  const { latest, missingSymbols } = data;

  if (missingSymbols.length > 0 || !latest) {
    return (
      <Alert color="gray" variant="light" title="数据生成中">
        <Text size="sm">当日的市场环境评估还没算出来，请稍后刷新。</Text>
      </Alert>
    );
  }

  const state = STATE_META[latest.fsmState];
  const path = PATH_META[latest.pathId];
  const pathLabel = MPR_PATH_LABEL[latest.pathId] ?? `P${latest.pathId}`;
  const reading = macroPhaseReading(latest);

  return (
    <Stack gap="lg">
      <SimpleGrid cols={{ base: 1, lg: 2 }} spacing="lg">
      <Card
        title={
          <Stack gap={2}>
            <Text size="sm" fw={700} c="gray.1">
              当前市场状态
            </Text>
            <Text size="xs" c="dimmed">
              {latest.date} 收盘 · 点击路径与力场查看说明
            </Text>
          </Stack>
        }
      >
        <div className="grid gap-5 md:grid-cols-[128px_1fr]">
          <div className="flex flex-col items-center justify-start gap-2">
            <RingProgress
              size={120}
              thickness={10}
              roundCaps
              sections={[{ value: latest.marketRiskScore, color: riskColor(latest.marketRiskScore) }]}
              label={
                <Stack gap={0} align="center">
                  <Text size="1.75rem" fw={600} c="gray.0" lh={1}>
                    {latest.marketRiskScore.toFixed(0)}
                  </Text>
                  <Text size="xs" c="dimmed">
                    压力分
                  </Text>
                </Stack>
              }
            />
            <Text size="sm" fw={600} c={`${state.color}.4`}>
              {state.label}
            </Text>
          </div>

          <Stack gap="xs" style={{ flex: 1, minWidth: 0 }}>
            <ClickPopover
              trigger={
                <Stack gap={2} className="rounded px-2 py-1 -mx-2 hover:bg-[var(--surface-hover)] transition-colors">
                  <Text size="xs" c="dimmed">
                    区制
                  </Text>
                  <Text size="sm" fw={600} c={`${path.color}.4`}>
                    {pathLabel}
                  </Text>
                  <Text size="xs" c="gray.2">
                    {reading.headline}
                  </Text>
                </Stack>
              }
            >
              <Stack gap={4}>
                <Text size="xs" c="dimmed" fw={600}>
                  {pathLabel}
                </Text>
                <Text size="xs" c="gray.2">
                  {reading.detail}
                </Text>
                <Text size="xs" c="dimmed">
                  {path.note}
                </Text>
              </Stack>
            </ClickPopover>

            <Stat label="现货破坏度" value={`${latest.spyDamage.toFixed(1)}%`} />
            <Stat
              label="领先质量分"
              value={latest.leadQuality.toFixed(1)}
              color={latest.leadQuality > 25 ? "teal.4" : latest.leadQuality > 10 ? "yellow.4" : undefined}
            />
            <Stat
              label="背离缺口 / 驻留"
              value={`${latest.leadGap >= 0 ? "+" : ""}${latest.leadGap.toFixed(1)} 点 / ${latest.leadPersist} Bar`}
            />
            <Stat
              label="相变速度"
              value={latest.transVel.toFixed(3)}
              color={latest.transVel > 0.05 ? "orange.4" : latest.transVel < -0.05 ? "teal.4" : undefined}
            />
            <Stat
              label="三域压力 (Vol/Cred/Spot)"
              value={`${latest.domVol.toFixed(0)} / ${latest.domCred.toFixed(0)} / ${latest.domSpot.toFixed(0)}`}
            />
            <Stat
              label="三域异动分级"
              value={`${SIGMA_LABEL[latest.sigmaVol]} / ${SIGMA_LABEL[latest.sigmaCred]} / ${SIGMA_LABEL[latest.sigmaSpot]}`}
              color={
                Math.max(latest.sigmaVol, latest.sigmaCred, latest.sigmaSpot) >= 2
                  ? "red.4"
                  : Math.max(latest.sigmaVol, latest.sigmaCred, latest.sigmaSpot) >= 1
                    ? "orange.4"
                    : undefined
              }
            />
            <Stat
              label="耦合率 / 传导深度"
              value={`${latest.couplingRatio.toFixed(3)} / T${latest.transDepth}`}
            />
          </Stack>
        </div>
      </Card>

      <Card
        title={
          <Stack gap={2}>
            <Text size="sm" fw={700} c="gray.1">
              五个维度的紧张程度
            </Text>
            <Text size="xs" c="dimmed">
              数值为过去一年中的排位，越高越紧张 · 点击查看数据来源
            </Text>
          </Stack>
        }
      >
        <Stack gap="xs">
          {FORCES.map((force) => (
            <ForceBar key={force.key} force={force} day={latest} />
          ))}
        </Stack>
      </Card>
      </SimpleGrid>
    </Stack>
  );
}
