"use client";

import { Card } from "@/components/Card";
import type { RotationData, RotationHolding } from "@/lib/dashboard/rotation";
import { Alert, Badge, Group, Stack, Text, Tooltip } from "@mantine/core";

const POS = "#089981";
const NEG = "#f23645";

const SIG_LABEL: Record<number, string> = { 1: "❤️ 一买", 2: "⭐️ 二买" };
const SIG_COLOR: Record<number, string> = { 1: "#ff4976", 2: "#fbbf24" };

const pct = (v: number, digits = 2) => `${v >= 0 ? "+" : ""}${v.toFixed(digits)}%`;
const money = (v: number | null) => (v == null ? "--" : `$${v.toFixed(2)}`);
const toneOf = (v: number) => (v >= 0 ? POS : NEG);

function HoldingRow({ holding }: { holding: RotationHolding }) {
  return (
    <tr className="border-t border-zinc-800/60">
      <td className="py-2 pr-3 font-medium text-zinc-100">{holding.symbol}</td>
      <td className="py-2 pr-3">
        <span className="text-xs font-semibold" style={{ color: SIG_COLOR[holding.sigType] }}>
          {SIG_LABEL[holding.sigType]}
        </span>
      </td>
      <td className="py-2 pr-3 text-right font-mono text-sky-300">
        {holding.weightPct.toFixed(1)}%
      </td>
      <td className="py-2 pr-3 text-right font-mono text-zinc-300">
        {money(holding.entryPrice)}
      </td>
      <td className="py-2 pr-3 text-right font-mono text-zinc-300">{money(holding.close)}</td>
      <td
        className="py-2 pr-3 text-right font-mono"
        style={{ color: toneOf(holding.floatPnlPct) }}
      >
        {pct(holding.floatPnlPct)}
      </td>
      <td
        className="py-2 pr-3 text-right font-mono"
        style={{ color: toneOf(holding.navContribPct) }}
      >
        {pct(holding.navContribPct)}
      </td>
      <td className="py-2 pr-3 text-right font-mono text-zinc-300">{holding.rs.toFixed(0)}</td>
      <td className="py-2 text-right font-mono text-amber-300">
        {money(holding.effectiveStop)}
        {holding.breakevenLocked ? (
          <Tooltip label="浮盈曾超过 10%，止损已上移至开仓价 × 1.01">
            <span className="ml-1 cursor-help text-emerald-400">🔒</span>
          </Tooltip>
        ) : null}
      </td>
    </tr>
  );
}

export function RotationBoard({ data }: { data: RotationData }) {
  if (data.latestDate == null) {
    return (
      <Alert color="gray" variant="light" title="数据生成中">
        <Text size="sm">当日的轮动结果还没算出来，请稍后刷新。</Text>
      </Alert>
    );
  }

  const { stats, holdings } = data;

  return (
    <Stack gap="md">
      <Card
        title={
          <Stack gap={2}>
            <Text size="sm" fw={700} c="gray.1">
              全口径净值核算
            </Text>
            <Text size="xs" c="dimmed">
              {data.latestDate} · 持仓 {holdings.length}/{data.universeSize} · RS 动态加权满仓
            </Text>
          </Stack>
        }
      >
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
          <Stack gap={2}>
            <Text size="xs" c="dimmed">
              当前满仓浮盈
            </Text>
            <Text size="xl" fw={700} ff="monospace" style={{ color: toneOf(stats.openNavPct) }}>
              {pct(stats.openNavPct)}
            </Text>
          </Stack>
          <Stack gap={2}>
            <Text size="xs" c="dimmed">
              年内已落袋
            </Text>
            <Text size="xl" fw={700} ff="monospace" style={{ color: toneOf(stats.closedNavPct) }}>
              {pct(stats.closedNavPct)}
            </Text>
          </Stack>
          <Stack gap={2}>
            <Text size="xs" c="dimmed">
              全口径 YTD
            </Text>
            <Text size="xl" fw={700} ff="monospace" style={{ color: toneOf(stats.totalNavPct) }}>
              {pct(stats.totalNavPct)}
            </Text>
          </Stack>
          <Stack gap={2}>
            <Text size="xs" c="dimmed">
              年内战绩
            </Text>
            <Text size="xl" fw={700} ff="monospace" c="gray.2">
              {stats.trades}战{stats.wins}胜
            </Text>
            <Text size="xs" c="dimmed" ff="monospace">
              胜率 {stats.winRatePct.toFixed(0)}%
            </Text>
          </Stack>
        </div>

        <Text size="xs" c="dimmed" mt="md">
          已落袋收益按平均满仓 8 只摊薄到组合层面。这是模型跟踪的结果，不是实盘记录。
        </Text>

        {data.macroExposure ? (
          <Alert color="gray" variant="light" mt="md">
            <Stack gap={4}>
              <Group gap="xs">
                <Text size="xs" c="dimmed">
                  MPR 建议总敞口（Path {data.macroExposure.pathId}）
                </Text>
                <Text size="xs" fw={700} c="gray.2" ff="monospace">
                  {data.macroExposure.minPct}% ~ {data.macroExposure.maxPct}%
                </Text>
                <Text size="xs" c="dimmed">
                  {data.macroExposure.stance}
                </Text>
              </Group>
              <Text size="xs" c="dimmed">
                仅作参考，上表仓位并未按此缩放。回测显示照此机械减仓虽然能把最大回撤从
                39% 收窄到 19%，但让出的收益更多，风险调整后的收益反而下降。
              </Text>
            </Stack>
          </Alert>
        ) : null}
      </Card>

      <Card
        title={
          <Stack gap={2}>
            <Text size="sm" fw={700} c="gray.1">
              当前持仓
            </Text>
            <Text size="xs" c="dimmed">
              仓位按 RS 在持仓标的间动态分配 · 止损取硬止损与吊灯的较大者
            </Text>
          </Stack>
        }
      >
        {holdings.length === 0 ? (
          <Text size="sm" c="dimmed">
            当前全部空仓,等待点火。
          </Text>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-zinc-500">
                  <th className="pb-2 pr-3 text-left font-normal">代码</th>
                  <th className="pb-2 pr-3 text-left font-normal">状态</th>
                  <th className="pb-2 pr-3 text-right font-normal">仓位</th>
                  <th className="pb-2 pr-3 text-right font-normal">开仓价</th>
                  <th className="pb-2 pr-3 text-right font-normal">现价</th>
                  <th className="pb-2 pr-3 text-right font-normal">浮盈</th>
                  <th className="pb-2 pr-3 text-right font-normal">净值拉动</th>
                  <th className="pb-2 pr-3 text-right font-normal">
                    <Tooltip label="四周期加权的绝对涨幅强度，不设基准。与深度面板的「相对 RS」是两套算法，数值不可互比。">
                      <span className="cursor-help border-b border-dotted border-zinc-600">
                        动能 RS
                      </span>
                    </Tooltip>
                  </th>
                  <th className="pb-2 text-right font-normal">止损</th>
                </tr>
              </thead>
              <tbody>
                {holdings.map((h) => (
                  <HoldingRow key={h.symbol} holding={h} />
                ))}
              </tbody>
            </table>
          </div>
        )}

        {holdings.some((h) => h.sigType === 2) ? (
          <Alert color="gray" variant="light" mt="md">
            {/* Text 默认渲染 <p>，而 Badge 是 <div>，套在一起是非法嵌套、会导致 hydration 失败 */}
            <Text size="xs" component="div">
              <Badge size="xs" color="yellow" variant="light" mr={6}>
                ⭐️ 二买
              </Badge>
              历史表现弱于一买：单看信号本身，二买后续走势并不优于同期大盘；
              配上止损后勉强能用，但盈亏比明显更差。持有这类仓位时建议更保守。
            </Text>
          </Alert>
        ) : null}

        {data.skippedSymbols.length > 0 ? (
          <Text size="xs" c="dimmed" mt="sm">
            样本不足 400 根、未纳入计算:{data.skippedSymbols.join(", ")}
          </Text>
        ) : null}
      </Card>
    </Stack>
  );
}
