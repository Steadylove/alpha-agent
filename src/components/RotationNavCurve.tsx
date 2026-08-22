"use client";

import { Card } from "@/components/Card";
import type { NavPoint } from "@/lib/dashboard/rotation";
import { Stack, Text } from "@mantine/core";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

const POS = "#089981";
const NEG = "#f23645";

type TooltipPayload = { payload: NavPoint }[];

function NavTooltip({ active, payload }: { active?: boolean; payload?: TooltipPayload }) {
  const point = payload?.[0]?.payload;
  if (!active || !point) return null;

  return (
    <div className="rounded border border-[var(--border-strong)] bg-[var(--surface-hover)]/95 px-3 py-2 text-xs">
      <div className="font-mono text-zinc-400">{point.date}</div>
      <div className="mt-1 font-mono" style={{ color: point.navPct >= 0 ? POS : NEG }}>
        净值 {point.navPct >= 0 ? "+" : ""}
        {point.navPct.toFixed(2)}%
      </div>
      <div className="font-mono text-zinc-400">回撤 {point.drawdownPct.toFixed(2)}%</div>
      <div className="font-mono text-zinc-500">持仓 {point.holdings} 只</div>
    </div>
  );
}

export function RotationNavCurve({
  curve,
  maxDrawdownPct,
}: {
  curve: NavPoint[];
  maxDrawdownPct: number;
}) {
  if (curve.length < 2) return null;

  const last = curve[curve.length - 1];
  const peak = curve.reduce((m, p) => Math.max(m, p.navPct), 0);
  const trough = curve.reduce((m, p) => Math.min(m, p.navPct), 0);
  const tone = last.navPct >= 0 ? POS : NEG;

  return (
    <Card
      title={
        <Stack gap={2}>
          <Text size="sm" fw={700} c="gray.1">
            全口径净值曲线
          </Text>
          <Text size="xs" c="dimmed">
            {curve[0].date} → {last.date} · 8 个等权仓位口径，已落袋与未平仓浮盈同除以 8
          </Text>
        </Stack>
      }
    >
      <div className="mb-3 flex flex-wrap gap-x-8 gap-y-2">
        <div>
          <div className="font-mono text-lg" style={{ color: tone }}>
            {last.navPct >= 0 ? "+" : ""}
            {last.navPct.toFixed(1)}%
          </div>
          <div className="text-xs text-zinc-500">当前净值</div>
        </div>
        <div>
          <div className="font-mono text-lg text-zinc-300">+{peak.toFixed(1)}%</div>
          <div className="text-xs text-zinc-500">年内峰值</div>
        </div>
        <div>
          <div className="font-mono text-lg" style={{ color: NEG }}>
            {maxDrawdownPct.toFixed(1)}%
          </div>
          <div className="text-xs text-zinc-500">最大回撤</div>
        </div>
        <div>
          <div className="font-mono text-lg text-zinc-300">{trough.toFixed(1)}%</div>
          <div className="text-xs text-zinc-500">年内谷值</div>
        </div>
      </div>

      <div style={{ height: 220 }}>
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={curve} margin={{ top: 4, right: 8, bottom: 0, left: -12 }}>
            <defs>
              <linearGradient id="navFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={tone} stopOpacity={0.35} />
                <stop offset="100%" stopColor={tone} stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid stroke="#27272a" vertical={false} />
            <XAxis
              dataKey="date"
              tick={{ fill: "#71717a", fontSize: 11 }}
              tickLine={false}
              axisLine={{ stroke: "#27272a" }}
              minTickGap={48}
              tickFormatter={(d: string) => d.slice(5)}
            />
            <YAxis
              tick={{ fill: "#71717a", fontSize: 11 }}
              tickLine={false}
              axisLine={false}
              width={48}
              tickFormatter={(v: number) => `${v.toFixed(0)}%`}
            />
            <ReferenceLine y={0} stroke="#3f3f46" />
            {/* Tooltip 自带 400ms 的 transform 过渡，不关掉的话每次都从上一个位置滑过来 */}
            <Tooltip
              content={<NavTooltip />}
              cursor={{ stroke: "#52525b" }}
              isAnimationActive={false}
            />
            <Area
              type="monotone"
              dataKey="navPct"
              stroke={tone}
              strokeWidth={1.75}
              fill="url(#navFill)"
              isAnimationActive={false}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>

      <div style={{ height: 72 }} className="mt-1">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={curve} margin={{ top: 4, right: 8, bottom: 0, left: -12 }}>
            <CartesianGrid stroke="#27272a" vertical={false} />
            <XAxis dataKey="date" hide />
            <YAxis
              tick={{ fill: "#71717a", fontSize: 10 }}
              tickLine={false}
              axisLine={false}
              width={48}
              tickFormatter={(v: number) => `${v.toFixed(0)}%`}
            />
            <Tooltip
              content={<NavTooltip />}
              cursor={{ stroke: "#52525b" }}
              isAnimationActive={false}
            />
            <Area
              type="monotone"
              dataKey="drawdownPct"
              stroke={NEG}
              strokeWidth={1}
              fill={NEG}
              fillOpacity={0.18}
              isAnimationActive={false}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>

      <Text size="xs" c="dimmed" mt="xs">
        下方红色区域是相对历史最高点的回撤深度。曲线全程按 8 个等权仓位记账，
        因此末点与上方「全口径 YTD」略有出入——后者的浮盈部分按当日持仓加权，
        持仓只剩两三只时权重会被放大，不适合拉成时间序列。
        这是模型跟踪的结果，未计入滑点、手续费与仓位取整。
      </Text>
    </Card>
  );
}
