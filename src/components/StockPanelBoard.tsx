"use client";

import { Card } from "@/components/Card";
import type { StockPanelData, StockPanelRow } from "@/lib/dashboard/stockPanel";
import { Alert, Stack, Text, Tooltip, UnstyledButton } from "@mantine/core";
import Link from "next/link";
import { useState } from "react";

const POS = "#089981";
const NEG = "#f23645";

const STAGE_LABEL: Record<string, string> = {
  A: "黄金突破带",
  B: "箱体蓄势",
  C: "单日跳空",
  D: "趋势衰减",
  E: "混沌筑底",
  W: "高波震荡",
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

/** 只有偏离基线的读数才值得占位；random / normal 一律不渲染。 */
const HURST_TAG: Record<string, { text: string; color: string }> = {
  trending: { text: "强趋势", color: "#089981" },
  reverting: { text: "均值回归", color: "#f59e0b" },
};

const VOL_TAG: Record<string, { text: string; color: string }> = {
  vcp_nr7: { text: "VCP+NR7", color: "#a855f7" },
  nr7: { text: "NR7", color: "#3b82f6" },
  vcp: { text: "VCP", color: "#3b82f6" },
  inside_bar: { text: "孕线", color: "#71717a" },
};

const FLOW_TAG: Record<string, { text: string; color: string }> = {
  pocket_pivot: { text: "机构点火", color: "#f23645" },
  dry_up: { text: "极度锁仓", color: "#22c55e" },
};

const DIP_QUALITY_COLOR: Record<string, string> = {
  prime: "#089981",
  dry_up: "#22c55e",
  normal: "#0ea5e9",
  bottom: "#71717a",
  choppy: "#f59e0b",
};

const SECTOR_STATUS_LABEL: Record<string, string> = {
  leader: "领涨主线",
  bottoming: "潜伏筑底",
  neutral: "中性轮动",
  outflow: "资金流出",
};

const SECTOR_STATUS_COLOR: Record<string, string> = {
  leader: "#089981",
  bottoming: "#a855f7",
  neutral: "#a1a1aa",
  outflow: "#f23645",
};

const TACTICAL_LABEL: Record<string, string> = {
  hold_ride: "🚀 顺势主升",
  hold_defend: "🛡️ 收紧防守",
  hold_derisk: "🚨 锁利降险",
  enter_standard: "⚡ 标准建仓",
  enter_light: "⚠️ 轻仓试错",
  enter_frozen: "🚨 冻结不接",
  wait_defensive: "🚨 全面防御",
  wait_dip: "🎯 回踩低吸",
  wait_avoid: "❌ 禁止介入",
  range_trade: "📊 区间套利",
  breakout_follow: "⚡ 突破追买",
  accumulate: "🕳️ 左侧分批",
};

const TACTICAL_DETAIL: Record<string, string> = {
  hold_ride: "宏观顺风共振，依托移动止盈线放大利润",
  hold_defend: "宏观转弱，上移移动止盈、推高保本锁，禁止加仓",
  hold_derisk: "宏观已破位或临界扩散，坚决禁止加仓，分批锁利",
  enter_standard: "宏观健康 + 背离点火，按标准风控执行建仓",
  enter_light: "跨市场暗流环境下点火，严格轻仓防守性试错",
  enter_frozen: "技术底背离点火但宏观高危，严禁抄底接飞刀",
  wait_defensive: "宏观风险正在向现货扩散，冻结所有多头买点与低吸",
  wait_dip: "不追高，仅在低吸下沿挂单分批布局",
  wait_avoid: "高位延伸或趋势破位，严禁追高与抄底",
  range_trade: "高波震荡箱体，在 ATR 弹性区间内做区间",
  breakout_follow: "黄金突破带成型，可突破追买并关注低吸区间",
  accumulate: "混沌筑底，分批建立底仓带，等待一买确认",
};

const TONE_COLOR: Record<string, string> = {
  danger: "#f23645",
  caution: "#f59e0b",
  neutral: "#a1a1aa",
  favorable: "#089981",
};

const LAYER_LABEL: Record<string, string> = {
  holding: "持仓层",
  signal: "点火层",
  regime: "形态层",
};

/**
 * 把 12 条战术指令按「该做什么」收成 4 组。
 *
 * 刻意不用 tacticalLayer 分组：那是推导来源（持仓/点火/形态），
 * 回答的是「这条结论怎么来的」，而看板要先回答「今天该动手吗」。
 */
const ACTION_GROUPS = [
  {
    id: "hold",
    label: "持仓防守",
    hint: "已有仓位，按宏观路径调整止盈止损",
    color: "#089981",
    actions: ["hold_ride", "hold_defend", "hold_derisk"],
  },
  {
    id: "enter",
    label: "可以建仓",
    hint: "点火或突破成型，风控放行",
    color: "#a855f7",
    actions: ["enter_standard", "enter_light", "breakout_follow"],
  },
  {
    id: "stalk",
    label: "条件埋伏",
    hint: "不追高，等回踩或分批布局",
    color: "#3b82f6",
    actions: ["wait_dip", "accumulate", "range_trade"],
  },
  {
    id: "avoid",
    label: "明确回避",
    hint: "宏观高危或趋势破位，禁止介入",
    color: "#f23645",
    actions: ["enter_frozen", "wait_defensive", "wait_avoid"],
  },
] as const;

const GROUP_OF = new Map<string, string>(
  ACTION_GROUPS.flatMap((g) => g.actions.map((a) => [a, g.id] as [string, string])),
);

const money = (v: number) => `$${v.toFixed(2)}`;
const pct = (v: number, digits = 1) => `${v >= 0 ? "+" : ""}${v.toFixed(digits)}%`;

function Tag({ text, color }: { text: string; color: string }) {
  return (
    <span
      className="rounded px-1 py-px text-[10px] leading-tight"
      style={{ color, background: `${color}1a` }}
    >
      {text}
    </span>
  );
}

/** 只渲染偏离基线的特征，随机分形态 / 正常波动这类无信息读数直接省略。 */
function TraitsCell({ row }: { row: StockPanelRow }) {
  const hurst = HURST_TAG[row.hurstReturnRegime];
  const vol = VOL_TAG[row.volatilityPattern];
  const flow = FLOW_TAG[row.moneyFlow];
  const netFlow = row.moneyFlow === "inflow" ? POS : row.moneyFlow === "outflow" ? NEG : null;

  if (!hurst && !vol && !flow && !netFlow) {
    return <span className="text-xs text-zinc-700">—</span>;
  }

  return (
    <div className="flex flex-wrap items-center gap-1">
      {vol ? <Tag text={vol.text} color={vol.color} /> : null}
      {flow ? <Tag text={flow.text} color={flow.color} /> : null}
      {hurst ? (
        <Tooltip label={`H=${row.hurstReturn.toFixed(3)}（Pine 价格口径 ${row.hurstPrice.toFixed(2)}）`}>
          <span className="cursor-help">
            <Tag text={hurst.text} color={hurst.color} />
          </span>
        </Tooltip>
      ) : null}
      {netFlow ? (
        <Tooltip label={`当日量 / 50 日均量 = ${row.volumeRatio.toFixed(2)}`}>
          <span className="cursor-help text-[10px]" style={{ color: netFlow }}>
            {row.moneyFlow === "inflow" ? "▲" : "▼"}
          </span>
        </Tooltip>
      ) : null}
    </div>
  );
}

function DipCell({ row }: { row: StockPanelRow }) {
  if (row.dipKind === "frozen") {
    return <span className="text-xs text-red-400">大盘高危，冻结</span>;
  }
  if (row.dipKind === "overextended") {
    return <span className="text-xs text-red-400">远离成本线</span>;
  }
  if (row.dipKind === "avoid") {
    return (
      <span className="font-mono text-xs text-red-400">
        观望（压制 {money(row.dipResistance ?? 0)}）
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

/** 持仓中的两条防线；空仓时返回空数组。 */
function slotLines(row: StockPanelRow): string[] {
  const lines: string[] = [];
  if (row.buy1Entry != null) {
    lines.push(
      `一买 建仓 ${money(row.buy1Entry)} · 止损 ${money(row.buy1Stop ?? 0)}` +
        `${row.buy1Locked ? "（已锁保本）" : ""} · 移动止损 ${money(row.buy1Trail ?? 0)}`,
    );
  }
  if (row.buy2Entry != null) {
    lines.push(
      `二买 建仓 ${money(row.buy2Entry)} · 止损 ${money(row.buy2Stop ?? 0)}` +
        `${row.buy2Locked ? "（已锁保本）" : ""} · 移动止损 ${money(row.buy2Trail ?? 0)}`,
    );
  }
  return lines;
}

function TacticalCell({ row }: { row: StockPanelRow }) {
  const lines = slotLines(row);
  const tip = (
    <div className="max-w-xs text-xs">
      <div>{TACTICAL_DETAIL[row.tacticalAction]}</div>
      <div className="mt-1 text-zinc-400">
        判定层：{LAYER_LABEL[row.tacticalLayer]}
        {row.smoothedRsi != null ? ` · 平滑 RSI ${row.smoothedRsi.toFixed(0)}` : ""}
      </div>
      {lines.map((l) => (
        <div key={l} className="mt-1 font-mono text-zinc-300">
          {l}
        </div>
      ))}
    </div>
  );

  return (
    <Tooltip label={tip} multiline>
      <span
        className="cursor-help text-xs font-semibold"
        style={{ color: TONE_COLOR[row.tacticalTone] }}
      >
        {TACTICAL_LABEL[row.tacticalAction] ?? row.tacticalAction}
        {lines.length > 0 ? <span className="ml-1 text-zinc-500">●{lines.length}</span> : null}
      </span>
    </Tooltip>
  );
}

function SectorCell({ row }: { row: StockPanelRow }) {
  if (!row.sectorStatus || !row.sectorName) {
    return <span className="text-xs text-zinc-600">—</span>;
  }
  return (
    <Tooltip label={SECTOR_STATUS_LABEL[row.sectorStatus]}>
      <span className="cursor-help text-xs" style={{ color: SECTOR_STATUS_COLOR[row.sectorStatus] }}>
        {row.sectorName} <span className="font-mono text-zinc-500">#{row.sectorRank}</span>
      </span>
    </Tooltip>
  );
}

function PanelRow({ row }: { row: StockPanelRow }) {
  return (
    <tr className="border-t border-zinc-800/60">
      <td className="py-2 pr-3">
        <Link
          href={`/depth/${row.symbol}`}
          className="font-medium text-zinc-100 underline decoration-zinc-700 underline-offset-2 transition-colors hover:decoration-zinc-400"
        >
          {row.symbol}
        </Link>
        <div className="max-w-[9rem] truncate text-xs text-zinc-500">{row.name}</div>
      </td>
      <td className="py-2 pr-3">
        <TacticalCell row={row} />
      </td>
      <td className="py-2 pr-3">
        <DipCell row={row} />
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
      <td
        className="py-2 pr-3 text-right font-mono text-xs"
        style={{ color: row.distFrom52wHigh >= -3 ? POS : "#a1a1aa" }}
      >
        {pct(row.distFrom52wHigh)}
      </td>
      <td className="py-2 pr-3">
        <div className="text-xs font-semibold" style={{ color: STAGE_COLOR[row.stage] }}>
          {STAGE_LABEL[row.stage] ?? row.stage}
        </div>
        <Tooltip label={`距上次跌破 EMA50×0.85 已 ${row.baseDays} 个交易日`}>
          <span className="cursor-help text-xs text-zinc-500">{TIER_LABEL[row.baseTier]}</span>
        </Tooltip>
      </td>
      <td className="py-2 pr-3">
        <SectorCell row={row} />
      </td>
      <td className="py-2">
        <TraitsCell row={row} />
      </td>
    </tr>
  );
}

function SectorClockCard({ data }: { data: StockPanelData }) {
  if (data.sectorClock.length === 0) return null;

  return (
    <Card
      title={
        <Stack gap={2}>
          <Text size="sm" fw={700} c="gray.1">
            SLS 3.0 行业生命周期时钟
          </Text>
          <Text size="xs" c="dimmed">
            11 只 SPDR 行业 ETF · 63 日涨幅比率排名 · 21 日超额对标 SPY
          </Text>
        </Stack>
      }
    >
      <div className="grid gap-x-6 gap-y-1 sm:grid-cols-2 lg:grid-cols-3">
        {data.sectorClock.map((s) => {
          const tag = s.isTop3 ? "🔥" : s.isBottoming ? "🌱" : "";
          const color = s.isTop3 ? "#089981" : s.isBottoming ? "#a855f7" : "#a1a1aa";
          return (
            <div key={s.sectorId} className="flex items-baseline gap-2 text-xs">
              <span className="w-6 shrink-0 text-right font-mono text-zinc-600">#{s.rank}</span>
              <span className="w-14 shrink-0" style={{ color }}>
                {tag} {s.name}
              </span>
              <span className="font-mono text-zinc-500">{s.symbol}</span>
              <span className="ml-auto font-mono text-zinc-400">{s.sls.toFixed(3)}</span>
              <span
                className="w-14 shrink-0 text-right font-mono"
                style={{ color: s.mom21 >= 0 ? POS : NEG }}
              >
                {pct(s.mom21 * 100, 2)}
              </span>
            </div>
          );
        })}
      </div>
      <Text size="xs" c="dimmed" mt="sm">
        🔥 前三名为领涨主线；🌱 为涨幅仍落后（SLS &lt; 1.05）但 21 日超额已转正（&gt; 1%）的资金回流候选。
        XLC 与 XLRE 分别成立于 2018-06 与 2015-10，更早的历史里这两档记 0 分、排名垫底。
      </Text>
    </Card>
  );
}

function GroupPill({
  label,
  hint,
  color,
  count,
  active,
  onClick,
}: {
  label: string;
  hint: string;
  color: string;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <Tooltip label={hint}>
      <UnstyledButton
        onClick={onClick}
        className="rounded-md border px-3 py-2 text-left transition-colors"
        style={{
          borderColor: active ? color : "#27272a",
          background: active ? `${color}14` : "transparent",
        }}
      >
        <div className="flex items-baseline gap-2">
          <span className="font-mono text-lg leading-none" style={{ color }}>
            {count}
          </span>
          <span className="text-xs" style={{ color: active ? color : "#a1a1aa" }}>
            {label}
          </span>
        </div>
      </UnstyledButton>
    </Tooltip>
  );
}

export function StockPanelBoard({ data }: { data: StockPanelData }) {
  const [activeGroup, setActiveGroup] = useState<string | null>(null);

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

  const groups = ACTION_GROUPS.map((g) => ({
    ...g,
    rows: data.rows.filter((r) => GROUP_OF.get(r.tacticalAction) === g.id),
  }));
  const ungrouped = data.rows.filter((r) => !GROUP_OF.has(r.tacticalAction));
  const visible = groups.filter((g) => g.rows.length > 0 && (!activeGroup || g.id === activeGroup));

  return (
    <Stack gap="md">
      <Card
        title={
          <Stack gap={2}>
            <Text size="sm" fw={700} c="gray.1">
              今日战术分布
            </Text>
            <Text size="xs" c="dimmed">
              {data.latestDate} · {data.rows.length}/{data.universeSize} 只 · 点击筛选，组内按相对 RS 降序
            </Text>
          </Stack>
        }
      >
        <div className="flex flex-wrap gap-2">
          <GroupPill
            label="全部"
            hint="显示全部标的"
            color="#a1a1aa"
            count={data.rows.length}
            active={activeGroup == null}
            onClick={() => setActiveGroup(null)}
          />
          {groups.map((g) => (
            <GroupPill
              key={g.id}
              label={g.label}
              hint={g.hint}
              color={g.color}
              count={g.rows.length}
              active={activeGroup === g.id}
              onClick={() => setActiveGroup(activeGroup === g.id ? null : g.id)}
            />
          ))}
        </div>
      </Card>

      {visible.map((g) => (
        <Card
          key={g.id}
          title={
            <div className="flex items-baseline gap-2">
              <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: g.color }} />
              <Text size="sm" fw={700} c="gray.1">
                {g.label}
              </Text>
              <Text size="xs" c="dimmed">
                {g.hint} · {g.rows.length} 只
              </Text>
            </div>
          }
        >
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-zinc-500">
                  <th className="pb-2 pr-3 text-left font-normal">代码</th>
                  <th className="pb-2 pr-3 text-left font-normal">战术指令</th>
                  <th className="pb-2 pr-3 text-left font-normal">低吸支撑带</th>
                  <th className="pb-2 pr-3 text-right font-normal">现价</th>
                  <th className="pb-2 pr-3 text-right font-normal">
                    <Tooltip label="对标 SPY 的四周期加权相对强度。与轮动看板的「动能 RS」是两套算法，数值不可互比。">
                      <span className="cursor-help border-b border-dotted border-zinc-600">
                        相对 RS
                      </span>
                    </Tooltip>
                  </th>
                  <th className="pb-2 pr-3 text-right font-normal">趋势分</th>
                  <th className="pb-2 pr-3 text-right font-normal">距 52 周高</th>
                  <th className="pb-2 pr-3 text-left font-normal">形态阶段</th>
                  <th className="pb-2 pr-3 text-left font-normal">行业时钟</th>
                  <th className="pb-2 text-left font-normal">特征</th>
                </tr>
              </thead>
              <tbody>
                {g.rows.map((row) => (
                  <PanelRow key={row.symbol} row={row} />
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      ))}

      {ungrouped.length > 0 ? (
        <Text size="xs" c="dimmed">
          未归入战术分组的指令：{ungrouped.map((r) => `${r.symbol}(${r.tacticalAction})`).join("、")}
        </Text>
      ) : null}

      <SectorClockCard data={data} />

      {data.skippedSymbols.length > 0 ? (
        <Text size="xs" c="dimmed">
          上市不足 900 根日线、EMA576 无法预热，未纳入计算：{data.skippedSymbols.join("、")}
        </Text>
      ) : null}

      <Card title="口径说明">
        <Stack gap="xs">
          <Text size="xs" c="dimmed">
            <strong className="text-zinc-300">战术指令</strong> 是全套系统的出口，三层仲裁、持仓优先：
            有持仓只看宏观路径，空仓遇点火看路径决定放行/轻仓/冻结，其余情况由路径与形态共同决定。
            悬停可见判定层、平滑 RSI 与当前两条防线的价位。上方四个分组按「今天该做什么」归并，
            与判定层不是一回事。
          </Text>
          <Text size="xs" c="dimmed">
            <strong className="text-zinc-300">相对 RS</strong> 是对标 SPY 的四周期加权相对强度
            （0.10/0.40/0.30/0.20 @ 21/63/126/252 日），1~99。这与轮动看板上的「动能 RS」
            是两套不同算法——那边不设基准、只看绝对涨幅，两个数字不可互相比较。
          </Text>
          <Text size="xs" c="dimmed">
            <strong className="text-zinc-300">特征</strong> 列只渲染偏离基线的读数。分形态判为「随机」
            （当日约占 46%）、波动形态判为「正常」（约 20%）都不占位，净流入/流出压缩成 ▲▼，
            只有机构点火与极度锁仓才给标签。三项合计的标签数因此减半，留下的才是真正偏离常态的信号。
          </Text>
          <Text size="xs" c="dimmed">
            <strong className="text-zinc-300">分形态</strong> 用 30 日 R/S 重标极差法。Pine
            原版把 R/S 直接套在收盘价上，实测 99.2% 的交易日都被判成「强趋势」——价格是累积量、
            自带趋势，套在它上面必然偏高。这里改喂日收益率，中位数落回 0.51，
            三档分布为随机 57% / 趋势 26% / 回归 17%。悬停可见原口径数值。
          </Text>
          <Text size="xs" c="dimmed">
            <strong className="text-zinc-300">距 52 周高</strong> 的基准是 Pine 的{" "}
            <code>highest(close[1], 252)</code>，只排除当日。标的在年内高点下方时这个数如实反映距离；
            一旦逼近或刷新高点，基准就退化成昨收，读数只剩当日涨幅——因此正值极小，p95 仅 +0.41%。
            受影响的是 Stage C：它的 +18% 门槛等于要求单日跳空 18% 以上突破年内新高，
            10 万个 bar-day 里只触发 23 次，实际含义是「单日爆量跳空」而非「高位延伸」。
          </Text>
          <Text size="xs" c="dimmed">
            <strong className="text-zinc-300">低吸支撑带</strong> 按形态阶段切换锚点：
            Stage A 锚 max(EMA20, VWAP90)，Stage B 锚 EMA50 与 Vegas 隧道，Stage E 下沉到
            EMA576 与 VWAP250×0.9。缓冲用的是 <code>sma(ATR14, 252)</code> 而非当期 ATR，
            因此带子不会随最近几天的波动大幅漂移。MPR 处于 Path 4 时全池冻结低吸。
          </Text>
          <Text size="xs" c="dimmed">
            <strong className="text-zinc-300">行业时钟</strong> 的归属取自 FMP 的 GICS 分类，映射规则
            照搬 Pine 的字符串匹配链。QQQ / GLD / IBIT 这类 ETF 本就没有行业归属
            （FMP 一律返回 Financial Services），不参与排名，显示为「—」。
          </Text>
          <Text size="xs" c="dimmed">
            <strong className="text-zinc-300">与 Pine 的一处偏离：</strong>Pine 的风控段跑在仲裁段之前，
            点火当根就已把开仓价填上，导致第 2 层「买点触发」永远够不着——而它的注释明写着
            「空仓状态下出现信号」。全历史 771 次点火里 584 次本该落在第 2 层、实际 0 次。
            这里改为排除「本根刚开的仓位」后再判持仓，让建仓当根正常给出 ⚡/⚠️/🚨 三条建仓指令。
          </Text>
          <Text size="xs" c="dimmed">
            <strong className="text-zinc-300">风控</strong> 与轮动看板是两套：这里一买、二买各占一个
            独立仓位槽可同时持有，硬止损 4×ATR，移动止损随浮盈三级收紧
            （5.5 → 20% 后 3.8 → 40% 后 2.8），浮盈 10% 上移硬止损至成本 ×1.01 锁保本。
            ATR 用的是 <code>sma(ATR14, 14)</code>，入场闸门是 <code>sma(RSI14, 14) &gt; 30</code>。
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
