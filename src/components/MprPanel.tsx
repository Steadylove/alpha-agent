"use client";

import { Card } from "@/components/Card";
import type { MacroPhaseSnapshot } from "@/lib/dashboard/mpr";
import {
  actionText,
  pathTopology,
  topRiskFactors,
  transitionGrade,
} from "@/lib/scoring/mprGuidance";
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
  0: { label: "S0 多头稳态", color: "teal" },
  1: { label: "S1 动能减弱", color: "yellow" },
  2: { label: "S2 承压下行", color: "orange" },
  3: { label: "S3 破位危机", color: "red" },
};

const PATH_META: Record<number, { label: string; color: string; note: string }> = {
  0: {
    label: "P0 稳态自洽",
    color: "teal",
    note: "兜底分支。原版判定树在此处有覆盖空洞，破坏度落在 60~70 且三域承压时也会落到这里，不等于「安全」。",
  },
  1: {
    label: "P1 跨市场暗流",
    color: "yellow",
    note: "衍生品或信用域异动、现货尚未反应。历史校准显示该路径后续 5 日下跌频率 29.1%，低于 39.1% 的基准。",
  },
  2: {
    label: "P2 相变扩散",
    color: "orange",
    note: "压力已扩散至现货。占全部交易日 35.3%，触发过于频繁，历史下跌频率 38.0% 与基准无异。",
  },
  3: { label: "P3 微观漂移", color: "yellow", note: "仅现货域异动，衍生品与信用域平静。" },
  4: {
    label: "P4 破位确认",
    color: "red",
    note: "唯一有统计意义的路径：后续 5 日跌幅超 3% 的概率 11.9%，约为其他路径的 3~4 倍。但同时平均收益也最高（+0.59%），应理解为「高波动区制」而非「看跌」。",
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

const TONE_COLOR: Record<string, string> = {
  positive: "teal",
  caution: "yellow",
  warning: "orange",
  danger: "red",
};

/**
 * Pine 第 246~289 行的实战指引与致险因子排序。
 *
 * 这是原版口径，会直接给方向与仓位。项目自己的校准判读（mprReading）刻意不给，
 * 因为 3928 日回测显示路径分级对 5 日方向没有预测力。两者并列展示，标签写清来源。
 */
function GuidanceCard({ day }: { day: MacroPhaseSnapshot }) {
  const topo = pathTopology(day.pathId);
  const trans = transitionGrade(day.pathId);
  const top = topRiskFactors(day);
  const act = actionText(day.pathId);

  return (
    <Card
      title={
        <Stack gap={2}>
          <Text size="sm" fw={700} c="gray.1">
            原版实战指引
          </Text>
          <Text size="xs" c="dimmed">
            按原始策略的口径直译 · 本项目的历史校准并不支持据此判断方向，仅作对照
          </Text>
        </Stack>
      }
    >
      <Stack gap="sm">
        <Text size="sm" fw={600} c={`${TONE_COLOR[topo.tone]}.4`}>
          {act}
        </Text>

        <SimpleGrid cols={{ base: 1, sm: 3 }} spacing="sm">
          <Stack gap={2}>
            <Text size="xs" c="dimmed">
              拓扑判定
            </Text>
            <Text size="xs" c={`${TONE_COLOR[topo.tone]}.4`} fw={500}>
              {topo.label}
            </Text>
          </Stack>
          <Stack gap={2}>
            <Text size="xs" c="dimmed">
              相变分级
            </Text>
            <Text size="xs" c={`${TONE_COLOR[trans.tone]}.4`} fw={500}>
              {trans.label}
            </Text>
            <Text size="xs" c="dimmed">
              {trans.desc}
            </Text>
          </Stack>
          <Stack gap={2}>
            <Text size="xs" c="dimmed">
              建议总敞口
            </Text>
            <Text size="xs" c="gray.2" fw={500} ff="monospace">
              {topo.exposureText}
            </Text>
          </Stack>
        </SimpleGrid>

        <Stack gap={2}>
          <Text size="xs" c="dimmed">
            当前压力最高的两个力场
          </Text>
          <Group gap="xs">
            {top.map((f) => (
              <Text key={f.name} size="xs" c="gray.2" ff="monospace">
                {f.name} {f.value.toFixed(1)}%
              </Text>
            ))}
          </Group>
        </Stack>
      </Stack>
    </Card>
  );
}

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
                    Risk
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
                    传导路径
                  </Text>
                  <Text size="sm" fw={600} c={`${path.color}.4`}>
                    {path.label}
                  </Text>
                </Stack>
              }
            >
              <Stack gap={4}>
                <Text size="xs" c="dimmed" fw={600}>
                  {path.label}
                </Text>
                <Text size="xs" c="gray.2">
                  {path.note}
                </Text>
              </Stack>
            </ClickPopover>

            <Stat
              label="5 日下跌概率"
              value={`${latest.prob5dDown.toFixed(1)}%`}
              color={
                latest.prob5dDown >= 60 ? "red.4" : latest.prob5dDown >= 45 ? "orange.4" : undefined
              }
            />
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

      <GuidanceCard day={latest} />
    </Stack>
  );
}
