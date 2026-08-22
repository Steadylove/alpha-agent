"use client";

import { Card } from "@/components/Card";
import type { StockPanelData, StockPanelRow } from "@/lib/dashboard/stockPanel";
import { actionText } from "@/lib/scoring/mprGuidance";
import { Accordion, Alert, Stack, Text, Tooltip, UnstyledButton } from "@mantine/core";
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

/** 12M 估值引擎的定价路径，对齐 MarketCompass Pine 第 490~571 行的分支。 */
const VALUATION_MODE_LABEL: Record<string, string> = {
  leader_mean_reversion: "龙头均值修复",
  bear_conservative: "空头保守 PE22",
  ps_revaluation: "高 PE 转 PS 重估",
  high_pe_expansion: "PE 扩张（封顶 75）",
  peg_growth: "PEG 成长模型",
  momentum_expansion: "超级动能 PE 扩张",
  trillion_baseline_pe: "万亿基准 PE30",
  steady_growth_pe: "稳健成长基准 PE",
  dynamic_ps: "动态 PS",
  anti_inversion: "强势防倒挂",
  trillion_cap: "万亿 +35% 封顶",
  structural_floor: "结构性兜底",
  technical_fallback: "纯技术兜底",
};

const ARCHETYPE_LABEL: Record<string, string> = {
  value_trend: "价值趋势",
  tech_only: "纯技术",
  high_beta_growth: "高贝塔成长",
  growth_premium: "成长溢价",
  distribution: "派发",
};

/** 目标价大多锚在现价上，只有这几条真正独立于当前价格。 */
const PRICE_INDEPENDENT_MODES = new Set([
  "peg_growth",
  "trillion_baseline_pe",
  "steady_growth_pe",
  "bear_conservative",
  "leader_mean_reversion",
]);

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
  // Pine 第 587 行的 upside>=15% 判定只喂给一个随后被各阶段分支覆盖的背景色，
  // 从不影响带子本身。这里同样只作提示，不拦截。
  const thinUpside = row.valuation != null && row.valuation.upsidePct < 15;
  const tip = (
    <div className="text-xs">
      <div>距上沿还需回调 {discount.toFixed(1)}%</div>
      {thinUpside ? (
        <div className="mt-1 text-amber-400">
          12M 上行空间不足 15%，原始模型在此标注「空间不足」，但不改变带子价位。
        </div>
      ) : null}
    </div>
  );
  return (
    <Tooltip label={tip} multiline>
      <span className="cursor-help font-mono text-xs" style={{ color }}>
        {money(row.dipLow ?? 0)} ~ {money(row.dipHigh ?? 0)}
        {thinUpside ? <span className="ml-1 text-amber-500">⌁</span> : null}
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

function TacticalCell({ row, pathId }: { row: StockPanelRow; pathId: number | null }) {
  const lines = slotLines(row);
  // Pine 第 277~289 行的原版指引，弱势分支要读 MPR 口径的 4Q-Alpha 而非面板的相对 RS
  const original =
    pathId == null
      ? null
      : actionText(pathId, { rsRating: row.mprAlphaRs, inDowntrend: row.inShortDowntrend });
  // Pine 第 842 行把目标价写进 Stage C 的右侧防御话术里，用来给分批止盈定锚
  const detail =
    row.tacticalAction === "wait_avoid" && row.stage === "C" && row.valuation
      ? `${TACTICAL_DETAIL.wait_avoid}，分批止盈可参考目标 ${money(row.valuation.primaryTarget)}`
      : TACTICAL_DETAIL[row.tacticalAction];
  const tip = (
    <div className="max-w-xs text-xs">
      <div>{detail}</div>
      <div className="mt-1 text-zinc-400">
        判定层：{LAYER_LABEL[row.tacticalLayer]}
        {row.smoothedRsi != null ? ` · 平滑 RSI ${row.smoothedRsi.toFixed(0)}` : ""}
      </div>
      {lines.map((l) => (
        <div key={l} className="mt-1 font-mono text-zinc-300">
          {l}
        </div>
      ))}
      {original ? (
        <div className="mt-2 border-t border-zinc-700 pt-1 text-zinc-400">
          <div className="text-zinc-500">原版口径指引</div>
          <div>{original}</div>
          <div className="text-zinc-500">
            MPR 4Q-Alpha {row.mprAlphaRs.toFixed(0)}
            {row.inShortDowntrend ? " · 短期空头排列" : ""}
          </div>
        </div>
      ) : null}
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

function ValuationCell({ row }: { row: StockPanelRow }) {
  const v = row.valuation;
  if (!v) {
    return (
      <Tooltip label="基本面数据缺失，或估值任务尚未覆盖该标的">
        <span className="cursor-help text-xs text-zinc-700">—</span>
      </Tooltip>
    );
  }

  const anchored = !PRICE_INDEPENDENT_MODES.has(v.mode);
  const tip = (
    <div className="max-w-xs text-xs">
      <div>
        定价路径：{VALUATION_MODE_LABEL[v.mode] ?? v.mode}
        {v.consensusSmoothed ? " · 已与卖方一致预期五五平滑" : ""}
      </div>
      <div className="mt-1 text-zinc-400">
        画像 {ARCHETYPE_LABEL[v.archetype] ?? v.archetype}
        {v.currentPe != null ? ` · 当前 PE ${v.currentPe.toFixed(1)}` : ""}
        {v.calculatedPe != null ? ` → 目标 PE ${v.calculatedPe.toFixed(1)}` : ""}
        {v.marketCapB != null ? ` · 市值 ${v.marketCapB.toFixed(0)}B` : ""}
      </div>
      {v.isHyperMomentum || v.isInLongDowntrend ? (
        <div className="mt-1 text-zinc-400">
          {v.isHyperMomentum ? "触发超级动能门槛。" : ""}
          {v.isInLongDowntrend ? "处于长期下行通道。" : ""}
        </div>
      ) : null}
      <div className="mt-1 text-zinc-400">
        短线目标 {money(v.shortTermTarget)}
        {v.squeezeTier === "swing"
          ? "（波段档：轧空数据无免费数据源，恒按 现价 + 2×ATR 计）"
          : v.squeezeTier === "warning"
            ? "（轧空预警）"
            : "（极高轧空）"}
      </div>
      {anchored ? (
        <div className="mt-1 text-amber-400">
          该路径的目标价是现价的固定倍数，不构成独立于价格的价值判断。
        </div>
      ) : null}
    </div>
  );

  return (
    <Tooltip label={tip} multiline>
      <span className="cursor-help font-mono text-xs">
        <span className="text-zinc-300">{money(v.primaryTarget)}</span>
        <span className="ml-1" style={{ color: v.upsidePct >= 0 ? POS : NEG }}>
          {pct(v.upsidePct)}
        </span>
        {anchored ? <span className="ml-1 text-zinc-600">≈</span> : null}
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

function PanelRow({ row, pathId }: { row: StockPanelRow; pathId: number | null }) {
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
        <TacticalCell row={row} pathId={pathId} />
      </td>
      <td className="py-2 pr-3">
        <DipCell row={row} />
      </td>
      <td className="py-2 pr-3 text-right font-mono text-zinc-300">{money(row.close)}</td>
      <td className="py-2 pr-3 text-right">
        <ValuationCell row={row} />
      </td>
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
        <Tooltip
          label={
            <div className="text-xs">
              <div>距上次跌破 EMA50×0.85 已 {row.baseDays} 个交易日</div>
              <div className="mt-1 text-zinc-400">
                布林 / 肯特纳带宽比 {row.squeezeRatio.toFixed(2)}
                {row.squeezeRatio > 1.35 ? "（超过 1.35，构成高波震荡条件）" : ""}
              </div>
            </div>
          }
          multiline
        >
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
      <Alert color="gray" variant="light" title="数据生成中">
        <Text size="sm">当日的个股面板还没算出来，请稍后刷新。</Text>
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
              {data.valuationDate && data.valuationDate !== data.latestDate
                ? ` · 估值数据截至 ${data.valuationDate}`
                : ""}
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
                    <Tooltip label="12 个月动态估值目标价与上行空间。标 ≈ 的表示该定价路径实为现价的固定倍数，参考价值有限。">
                      <span className="cursor-help border-b border-dotted border-zinc-600">
                        12M 目标
                      </span>
                    </Tooltip>
                  </th>
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
                  <PanelRow key={row.symbol} row={row} pathId={data.pathId} />
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
          上市时间太短、长周期均线无法计算，暂未纳入：{data.skippedSymbols.join("、")}
        </Text>
      ) : null}

      <Accordion variant="separated" chevronPosition="left">
        <Accordion.Item value="how">
          <Accordion.Control>
            <Text size="sm" fw={600} c="gray.2">
              这些指标怎么读
            </Text>
          </Accordion.Control>
          <Accordion.Panel>
            <Stack gap="sm">
              <Text size="xs" c="dimmed">
                <strong className="text-zinc-300">战术指令</strong>{" "}
                是整套系统的结论。持仓优先：已有仓位时只看大盘环境决定守还是撤；空仓遇到买点，
                由大盘环境决定放行、轻仓还是冻结；其余情况看形态。悬停可以看到判定依据和防线价位。
              </Text>
              <Text size="xs" c="dimmed">
                <strong className="text-zinc-300">相对 RS</strong>{" "}
                衡量的是跑赢标普 500 的程度，1~99。轮动持仓页上的「动能 RS」不设基准、只看绝对涨幅，
                两个数字算法不同，<strong className="text-zinc-300">不能互相比较</strong>。
              </Text>
              <Text size="xs" c="dimmed">
                <strong className="text-zinc-300">特征</strong>{" "}
                只显示偏离常态的信号。分形态为「随机」、波动为「正常」这类没有信息量的读数一律不占位，
                资金净流入流出压缩成 ▲▼，只有机构点火和极度锁仓才给标签。
              </Text>
              <Text size="xs" c="dimmed">
                <strong className="text-zinc-300">低吸支撑带</strong>{" "}
                会随形态切换锚点：强势股锚在短期均线与成交量加权成本上，筑底股则下沉到长期成本区。
                缓冲用的是一年期的平均波动率，所以带子不会因为最近几天的剧烈波动大幅漂移。
                大盘进入破位状态时，全池冻结低吸。
              </Text>
              <Text size="xs" c="dimmed">
                <strong className="text-zinc-300">12M 目标</strong>{" "}
                是估值引擎按市值、盈利、成长速度选一条定价路径推出的十二个月目标价，
                再乘大盘环境系数。悬停可以看到走的是哪条路径。
                标了 ≈ 的表示这条路径本质是现价乘一个固定倍数，
                <strong className="text-zinc-300">不构成独立于价格的价值判断</strong>，
                只有 PEG 与市值基准 PE 两类才真正用到每股收益。
              </Text>
              <Text size="xs" c="dimmed">
                <strong className="text-zinc-300">风控</strong>{" "}
                与轮动持仓页是两套：这里一买、二买各占一个独立仓位槽、可同时持有。
                每个槽有两条并行防线：硬止损起于成本下方 4 倍波动幅度，浮盈 10%
                后上移到成本之上锁定保本；另一条移动止损起点更低（5.5 倍），跟随持仓期最高价上抬、
                只升不降，并随浮盈三级收紧（20% 和 40% 各收一次）。跌破任意一条即离场。
              </Text>
            </Stack>
          </Accordion.Panel>
        </Accordion.Item>

        <Accordion.Item value="limits">
          <Accordion.Control>
            <Text size="sm" fw={600} c="gray.2">
              使用前请了解的局限
            </Text>
          </Accordion.Control>
          <Accordion.Panel>
            <Stack gap="sm">
              <Text size="xs" c="dimmed">
                <strong className="text-zinc-300">标的池存在幸存者偏差。</strong>{" "}
                这 40 只是为 2026 年挑选的，其中不少是事后才看得出的赢家，且有六只 2020
                年后才上市、整个生命周期都在牛市里。历史统计因此系统性偏乐观。
              </Text>
              <Text size="xs" c="dimmed">
                <strong className="text-zinc-300">近两年跑输买入持有。</strong>{" "}
                同期直接持有这些标的中位收益 +124%，而策略只有 +25%，40 只里仅 6
                只跑赢。平均在场时间只有两成，单边上涨行情中空仓就是成本。
                这套方法的价值在控制回撤，而不是在牛市里放大收益。
              </Text>
              <Text size="xs" c="dimmed">
                <strong className="text-zinc-300">「距 52 周高」在创新高时会失真。</strong>{" "}
                它的基准不含当日，所以标的在高点下方时如实反映距离，一旦刷新高点，
                读数就只剩当日涨幅。
              </Text>
              <Text size="xs" c="dimmed">
                <strong className="text-zinc-300">部分标的没有行业归属。</strong>{" "}
                QQQ、GLD、IBIT 这类 ETF 本就不属于任何行业，不参与行业排名，显示为「—」。
              </Text>
              <Text size="xs" c="dimmed">
                <strong className="text-zinc-300">12M 目标价的区分度有限。</strong>{" "}
                原始模型里绝大多数分支在代数上会退化成现价乘一个系数，末尾的「防倒挂」
                还会把强势标的的目标强制顶到现价的 1.22 倍。它更接近动能强度的价格投影，
                不宜当作内在价值来用。基本面覆盖不全时该列显示「—」。
              </Text>
            </Stack>
          </Accordion.Panel>
        </Accordion.Item>
      </Accordion>
    </Stack>
  );
}
