"use client";

import { Card } from "@/components/Card";
import type { StockPanelData, StockPanelRow } from "@/lib/dashboard/stockPanel";
import { Alert, Badge, Group, Stack, Text, Tooltip } from "@mantine/core";

const POS = "#089981";
const NEG = "#f23645";

const STAGE_LABEL: Record<string, string> = {
  A: "⚡ 黄金突破带",
  B: "🎯 箱体蓄势",
  C: "❌ 单日跳空",
  D: "📉 趋势衰减",
  E: "🕳️ 混沌筑底",
  W: "📊 高波震荡",
};

const STAGE_COLOR: Record<string, string> = {
  A: "#a855f7",
  B: "#3b82f6",
  C: "#f23645",
  D: "#f23645",
  E: "#71717a",
  W: "#f59e0b",
};

const TIER_LABEL: Record<string, string> = {
  T1: "T1 中继",
  T2: "T2 黄金",
  T3: "T3 发射井",
};

const HURST_LABEL: Record<string, string> = {
  trending: "🟢 强趋势",
  reverting: "🔄 均值回归",
  random: "⚖️ 随机",
};

const VOL_LABEL: Record<string, string> = {
  vcp_nr7: "⚡ VCP+NR7 引爆",
  nr7: "🎯 NR7 收缩",
  vcp: "🌊 VCP 收敛",
  inside_bar: "📦 孕线",
  normal: "⚪ 正常",
};

const FLOW_LABEL: Record<string, string> = {
  pocket_pivot: "🔥 机构点火",
  dry_up: "🌊 极度锁仓",
  inflow: "🟢 净流入",
  outflow: "🔴 净流出",
};

const DIP_QUALITY_COLOR: Record<string, string> = {
  prime: "#089981",
  dry_up: "#22c55e",
  normal: "#0ea5e9",
  bottom: "#71717a",
  choppy: "#f59e0b",
};

const money = (v: number) => `$${v.toFixed(2)}`;
const pct = (v: number, digits = 1) => `${v >= 0 ? "+" : ""}${v.toFixed(digits)}%`;

function DipCell({ row }: { row: StockPanelRow }) {
  if (row.dipKind === "frozen") {
    return <span className="text-xs text-red-400">🚨 大盘高危，低吸冻结</span>;
  }
  if (row.dipKind === "overextended") {
    return <span className="text-xs text-red-400">❌ 远离成本线</span>;
  }
  if (row.dipKind === "avoid") {
    return (
      <span className="font-mono text-xs text-red-400">
        📉 观望（压制 {money(row.dipResistance ?? 0)}）
      </span>
    );
  }
  const color = DIP_QUALITY_COLOR[row.dipQuality ?? "normal"];
  const discount = ((row.close - (row.dipHigh ?? row.close)) / row.close) * 100;
  return (
    <Tooltip label={`距上沿还需回调 ${discount.toFixed(1)}%`}>
      <span className="cursor-help font-mono text-xs" style={{ color }}>
        {money(row.dipLow ?? 0)} ~ {money(row.dipHigh ?? 0)}
      </span>
    </Tooltip>
  );
}

function PanelRow({ row }: { row: StockPanelRow }) {
  return (
    <tr className="border-t border-zinc-800/60">
      <td className="py-2 pr-3">
        <div className="font-medium text-zinc-100">{row.symbol}</div>
        <div className="max-w-[9rem] truncate text-xs text-zinc-500">{row.name}</div>
      </td>
      <td className="py-2 pr-3 text-right font-mono text-zinc-300">{money(row.close)}</td>
      <td className="py-2 pr-3 text-right">
        <span className="font-mono text-sky-300">{row.rs.toFixed(0)}</span>
        <Tooltip label={row.rsAccelerating ? "21 日超额强于 63 日" : "21 日超额弱于 63 日"}>
          <span
            className="ml-1 cursor-help text-xs"
            style={{ color: row.rsAccelerating ? POS : NEG }}
          >
            {row.rsAccelerating ? "▲" : "▼"}
          </span>
        </Tooltip>
      </td>
      <td className="py-2 pr-3 text-right font-mono text-zinc-300">{row.trendScore}/10</td>
      <td className="py-2 pr-3">
        <div className="text-xs font-semibold" style={{ color: STAGE_COLOR[row.stage] }}>
          {STAGE_LABEL[row.stage] ?? row.stage}
        </div>
        <Tooltip label={`距上次跌破 EMA50×0.85 已 ${row.baseDays} 个交易日`}>
          <span className="cursor-help text-xs text-zinc-500">{TIER_LABEL[row.baseTier]}</span>
        </Tooltip>
      </td>
      <td
        className="py-2 pr-3 text-right font-mono text-xs"
        style={{ color: row.distFrom52wHigh >= -3 ? POS : "#a1a1aa" }}
      >
        {pct(row.distFrom52wHigh)}
      </td>
      <td className="py-2 pr-3 text-xs text-zinc-300">
        <Tooltip label={`H=${row.hurstReturn.toFixed(3)}（Pine 价格口径 ${row.hurstPrice.toFixed(2)}）`}>
          <span className="cursor-help">{HURST_LABEL[row.hurstReturnRegime]}</span>
        </Tooltip>
      </td>
      <td className="py-2 pr-3 text-xs text-zinc-300">{VOL_LABEL[row.volatilityPattern]}</td>
      <td className="py-2 pr-3 text-xs text-zinc-300">
        <Tooltip label={`当日量 / 50 日均量 = ${row.volumeRatio.toFixed(2)}`}>
          <span className="cursor-help">{FLOW_LABEL[row.moneyFlow]}</span>
        </Tooltip>
      </td>
      <td className="py-2">
        <DipCell row={row} />
      </td>
    </tr>
  );
}

export function StockPanelBoard({ data }: { data: StockPanelData }) {
  if (data.latestDate == null) {
    return (
      <Alert color="yellow" variant="light" title="尚无个股面板数据">
        <Text size="sm">
          请先执行 <code>npm run backfill:rotation</code> 回填日线，再触发{" "}
          <code>POST /api/jobs/stock-panel</code>。
        </Text>
      </Alert>
    );
  }

  return (
    <Stack gap="md">
      <Card
        title={
          <Stack gap={2}>
            <Text size="sm" fw={700} c="gray.1">
              个股深度面板
            </Text>
            <Text size="xs" c="dimmed">
              {data.latestDate} · {data.rows.length}/{data.universeSize} 只 · 按 RS 降序
            </Text>
          </Stack>
        }
      >
        <Group gap="xs" mb="md">
          {data.stageCounts.map((s) => (
            <Badge key={s.stage} size="sm" variant="light" color="gray">
              <span style={{ color: STAGE_COLOR[s.stage] }}>{STAGE_LABEL[s.stage]}</span>
              <span className="ml-1 font-mono">{s.count}</span>
            </Badge>
          ))}
        </Group>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs text-zinc-500">
                <th className="pb-2 pr-3 text-left font-normal">代码</th>
                <th className="pb-2 pr-3 text-right font-normal">现价</th>
                <th className="pb-2 pr-3 text-right font-normal">RS</th>
                <th className="pb-2 pr-3 text-right font-normal">趋势分</th>
                <th className="pb-2 pr-3 text-left font-normal">形态阶段</th>
                <th className="pb-2 pr-3 text-right font-normal">距 52 周高</th>
                <th className="pb-2 pr-3 text-left font-normal">分形态</th>
                <th className="pb-2 pr-3 text-left font-normal">波动</th>
                <th className="pb-2 pr-3 text-left font-normal">资金</th>
                <th className="pb-2 text-left font-normal">低吸支撑带</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((row) => (
                <PanelRow key={row.symbol} row={row} />
              ))}
            </tbody>
          </table>
        </div>

        {data.skippedSymbols.length > 0 ? (
          <Text size="xs" c="dimmed" mt="sm">
            上市不足 900 根日线、EMA576 无法预热，未纳入计算：{data.skippedSymbols.join("、")}
          </Text>
        ) : null}
      </Card>

      <Card title="口径说明">
        <Stack gap="xs">
          <Text size="xs" c="dimmed">
            <strong className="text-zinc-300">RS</strong> 是对标 SPY 的四周期加权相对强度
            （0.10/0.40/0.30/0.20 @ 21/63/126/252 日），1~99。这与轮动看板上的 RS
            是两套不同算法——那边不设基准、只看绝对涨幅，两个数字不可互相比较。
          </Text>
          <Text size="xs" c="dimmed">
            <strong className="text-zinc-300">分形态</strong> 用 30 日 R/S 重标极差法。Pine
            原版把 R/S 直接套在收盘价上，实测 99.2% 的交易日都被判成「强趋势」——价格是累积量、
            自带趋势，套在它上面必然偏高。这里改喂日收益率，中位数落回 0.51，
            三档分布为随机 57% / 趋势 26% / 回归 17%。悬停可见原口径数值。
          </Text>
          <Text size="xs" c="dimmed">
            <strong className="text-zinc-300">距 52 周高</strong> 的基准是 Pine 的{" "}
            <code>highest(close[1], 252)</code>，只排除当日。对稳步上涨的标的它就等于昨收，
            所以这个数基本等于当日涨幅，p95 只有 +0.41%。Stage C 的 +18% 门槛因此要求单日跳空
            18% 以上突破年内新高，10 万个 bar-day 里只触发 23 次，实际含义是「单日爆量跳空」
            而非「高位延伸」。
          </Text>
          <Text size="xs" c="dimmed">
            <strong className="text-zinc-300">低吸支撑带</strong> 按形态阶段切换锚点：
            Stage A 锚 max(EMA20, VWAP90)，Stage B 锚 EMA50 与 Vegas 隧道，Stage E 下沉到
            EMA576 与 VWAP250×0.9。缓冲用的是 <code>sma(ATR14, 252)</code> 而非当期 ATR，
            因此带子不会随最近几天的波动大幅漂移。MPR 处于 Path 4 时全池冻结低吸。
          </Text>
          <Text size="xs" c="dimmed">
            标的池是轮动雷达那 40 只，为 2026 年选定，<strong className="text-zinc-300">幸存者偏差很重</strong>
            ——四成时间落在 Stage A 是标的池的性质，不是闸门宽松。
          </Text>
        </Stack>
      </Card>
    </Stack>
  );
}
