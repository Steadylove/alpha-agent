"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Badge,
  Button,
  Group,
  Loader,
  NumberInput,
  Pagination,
  SegmentedControl,
  Slider,
  Stack,
  Switch,
  Table,
  Text,
} from "@mantine/core";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Download,
  Eye,
  EyeOff,
  RotateCcw,
} from "lucide-react";

import { Card } from "@/components/Card";
import { LabFundChart } from "@/components/LabFundChart";
import { LabSymbolChart, type ChartTarget } from "@/components/LabSymbolChart";
import type { DayBook, HoldingDay, YearToDate } from "@/lib/backtest/engine";

const POS = "#089981";
const NEG = "#f23645";

type WindowResult = {
  label: string;
  from: string;
  to: string;
  trade: {
    trades: number;
    winRatePct: number;
    meanPnlPct: number;
    medianPnlPct: number;
    profitFactor: number;
    avgBarsHeld: number;
    worstPnlPct: number;
    meanR: number;
    exits: { stop: number; target: number; veto: number; rsWeak: number };
  };
  portfolio: Stats;
  benchmark: Stats;
};

type Stats = {
  equity: number;
  cagrPct: number;
  maxDrawdownPct: number;
  volPct: number;
  investedDayPct: number;
  avgExposurePct: number;
  days: number;
};

type ExitReason = "stop" | "target" | "veto" | "rsWeak";

type TradeRow = {
  symbol: string;
  sigType: 1 | 2;
  entryDate: string;
  entryPrice: number;
  exitDate: string;
  exitPrice: number;
  pnlPct: number;
  barsHeld: number;
  exitReason: ExitReason;
  /** 开仓时 1R 占开仓价的百分比 */
  riskPct: number;
  r: number;
  isOutOfSample: boolean;
};

type Result = {
  /** 服务端实际生效的参数，切分日以它为准，避免前后端各存一份 */
  config: { splitDate: string };
  index: IndexKey;
  indexLabel: string;
  trades: TradeRow[];
  inSample: WindowResult;
  outOfSample: WindowResult;
  byYear: {
    year: number;
    trades: number;
    strategyPct: number;
    benchmarkPct: number;
    spyPct: number | null;
    isOutOfSample: boolean;
  }[];
  equity: { date: string; strategy: number; benchmark: number }[];
  book: DayBook[];
  holdings: HoldingDay[];
  ytd: YearToDate | null;
  universeSize: number;
  signalCount: number;
  elapsedMs: number;
};

type Params = {
  rpsMin: number;
  rpsExit: number | null;
  stopMult: number;
  trailMult: number;
  takeProfitR: number | null;
  riskBudgetPct: number | null;
  useBuy1: boolean;
  useBuy2: boolean;
  minAdtvUsd: number;
  minPrice: number;
  requireTrend: boolean;
  requireRsi: boolean;
  minRsi: number;
  requireVegas: boolean;
  vegasFastA: number;
  vegasFastB: number;
  vegasSlowA: number;
  vegasSlowB: number;
  rpsWeightPower: number | null;
};

/** 与 engine.ts 的 DEFAULT_BACKTEST_CONFIG 保持一致，来源见那里的注释。 */
const DEFAULTS: Params = {
  rpsMin: 30,
  rpsExit: null,
  stopMult: 4,
  trailMult: 2,
  takeProfitR: null,
  riskBudgetPct: null,
  useBuy1: true,
  useBuy2: true,
  minAdtvUsd: 0,
  minPrice: 0,
  requireTrend: false,
  requireRsi: false,
  minRsi: 30,
  requireVegas: false,
  vegasFastA: 166,
  vegasFastB: 169,
  vegasSlowA: 576,
  vegasSlowB: 676,
  rpsWeightPower: null,
};

/** Small Fund 五年平台组：关闸门、RPS≥40、吊灯 5.5、止盈 1R、k=1。 */
const SMALLFUND_DEFAULTS: Params = {
  ...DEFAULTS,
  rpsMin: 40,
  trailMult: 5.5,
  takeProfitR: 1,
  useBuy2: true,
  requireRsi: false,
  requireVegas: false,
  rpsWeightPower: 1,
};

/** Pine 原值，用于一键对照。 */
const PINE_DEFAULTS: Params = {
  ...DEFAULTS,
  rpsMin: 0,
  stopMult: 4,
  trailMult: 5.5,
  takeProfitR: null,
  useBuy2: true,
};

/**
 * 「全市场流动性初筛」规格第一阶段的原始阈值。
 * 市值 >= 20 亿那条没实现（面板无历史股本，且标普成分极少跌破），故不在此列。
 */
const SPEC_FILTERS: Pick<Params, "minAdtvUsd" | "minPrice" | "requireTrend"> = {
  minAdtvUsd: 30_000_000,
  minPrice: 5,
  requireTrend: true,
};

type IndexKey = "UNION" | "SP500" | "NDX100" | "SMALLFUND";

/**
 * 标的池不并入 Params：它决定载入哪批数据，而 Params 是在同一批数据上重算的
 * 引擎参数。并进去的话，「Pine 原值」「复原」这类整体替换会把池子一起重置。
 */
const POOLS: { value: IndexKey; label: string }[] = [
  { value: "UNION", label: "两者并集" },
  { value: "SP500", label: "标普 500" },
  { value: "NDX100", label: "纳斯达克 100" },
  { value: "SMALLFUND", label: "Small Fund 100" },
];

const VEGAS_SPEC = { vegasFastA: 166, vegasFastB: 169, vegasSlowA: 576, vegasSlowB: 676 };
const VEGAS_SHORT = { vegasFastA: 200, vegasFastB: 200, vegasSlowA: 250, vegasSlowB: 250 };

const pct = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;
const tone = (v: number) => (v >= 0 ? POS : NEG);

/** 窗口内标普净值倍数；账本已按窗口首日前一日归一。 */
function spyMultiple(book: DayBook[], from: string, to: string): number | null {
  const end = book.findLast((d) => d.date <= to && d.date >= from && d.spy != null);
  const prev = book.findLast((d) => d.date < from && d.spy != null);
  if (!end?.spy) return null;
  return end.spy / (prev?.spy ?? 1);
}

/**
 * 初始止损比吊灯宽时它当不成出场线，但并不因此变成惰性参数：它定义 1R，
 * 而 1R 同时进入 R 倍数的显示、止盈距离和风险定仓的仓位公式。
 * 所以这里按当前开关逐项列出它还在影响什么，而不是笼统说「不会有变化」。
 */
function stopMultHint(p: Params): string {
  if (p.stopMult < p.trailMult) {
    return "比吊灯紧，是真正生效的初始止损。同时定义 1R。Pine 原值 4.0。";
  }
  const effects = ["改变 R 列与平均 R"];
  if (p.takeProfitR != null) effects.push("决定止盈距离");
  if (p.riskBudgetPct != null) effects.push("按「预算 ÷ 止损距离」直接改仓位与收益");
  return (
    "比吊灯宽，作为出场线永不触发——退出条件是「收盘低于止损或低于吊灯」，" +
    `吊灯位更高会先触发。但它定义 1R，因此仍会${effects.join("、")}。`
  );
}

export function LabWorkbench() {
  const [params, setParams] = useState<Params>(SMALLFUND_DEFAULTS);
  const [index, setIndex] = useState<IndexKey>("SMALLFUND");
  const [result, setResult] = useState<Result | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showOos, setShowOos] = useState(false);
  const [showMore, setShowMore] = useState(false);
  /** 点开哪只标的的哪一笔，null 为关闭弹窗。 */
  const [chartTarget, setChartTarget] = useState<ChartTarget | null>(null);
  /** 传给弹窗的配置要是稳定引用，否则它每次渲染都会重新取数。 */
  const chartRequest = useMemo(() => ({ ...params, index }), [params, index]);

  /** 试过的不同参数组合数，以及偷看保留区的次数——都是过拟合的计价单位。 */
  const tried = useRef(new Set<string>());
  const [trialCount, setTrialCount] = useState(0);
  const [peekCount, setPeekCount] = useState(0);

  const run = useCallback(async (p: Params, idx: IndexKey) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/lab/backtest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...p, index: idx }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "回测失败");
      setResult(json as Result);
    } catch (e) {
      setError(e instanceof Error ? e.message : "回测失败");
    } finally {
      setLoading(false);
    }
  }, []);

  // 滑块连续拖动时不必每帧都打接口
  useEffect(() => {
    // 换池子也算一次试验：在另一个池子上重测同一组参数同样是在挑结果
    const key = JSON.stringify({ params, index });
    const timer = setTimeout(() => {
      if (!tried.current.has(key)) {
        tried.current.add(key);
        setTrialCount(tried.current.size);
      }
      void run(params, index);
    }, 350);
    return () => clearTimeout(timer);
  }, [params, index, run]);

  const set = <K extends keyof Params>(key: K, value: Params[K]) =>
    setParams((prev) => ({ ...prev, [key]: value }));

  const revealOos = () => {
    if (!showOos) setPeekCount((n) => n + 1);
    setShowOos((v) => !v);
  };

  const inExcess = result
    ? result.inSample.portfolio.cagrPct - result.inSample.benchmark.cagrPct
    : 0;
  const outExcess = result
    ? result.outOfSample.portfolio.cagrPct - result.outOfSample.benchmark.cagrPct
    : 0;

  return (
    <Stack gap="lg">
      <Card
        title="参数"
        action={
          <Group gap="xs">
            {loading ? <Loader size="xs" color="gray" /> : null}
            <Text size="xs" c="dimmed" ff="monospace">
              {result ? `${result.elapsedMs}ms` : ""}
            </Text>
            <Button
              size="compact-xs"
              variant="default"
              onClick={() => setParams(PINE_DEFAULTS)}
            >
              Pine 原值
            </Button>
            <Button
              size="compact-xs"
              variant="default"
              leftSection={<RotateCcw className="h-3 w-3" />}
              onClick={() =>
                setParams(index === "SMALLFUND" ? SMALLFUND_DEFAULTS : DEFAULTS)
              }
            >
              复原
            </Button>
          </Group>
        }
      >
        <Stack gap="xs" mb="lg">
          <Group gap="sm" align="center">
            <Text size="sm" fw={500}>
              标的池
            </Text>
            <SegmentedControl
              size="xs"
              value={index}
              onChange={(v) => {
                const next = v as IndexKey;
                setIndex(next);
                setParams(next === "SMALLFUND" ? SMALLFUND_DEFAULTS : DEFAULTS);
              }}
              data={POOLS}
            />
            {result ? (
              <Text size="xs" c="dimmed" ff="monospace">
                池内 {result.universeSize} 只
              </Text>
            ) : null}
          </Group>
          <Text size="xs" c="dimmed">
            Small Fund 是事后名单，只看同池差。灰线同池等权，琥珀线标普。
          </Text>
        </Stack>

        <div className="grid gap-x-10 gap-y-6 md:grid-cols-2">
          <Knob
            label="截面 RPS 门槛"
            value={params.rpsMin}
            display={params.rpsMin === 0 ? "不筛选" : `≥ ${params.rpsMin}`}
            hint="只在当日成分股之间排名。买点是抄底信号，天然出现在弱势股上，门槛调高会大量砍掉成交。"
            min={0}
            max={95}
            step={5}
            onChange={(v) => set("rpsMin", v)}
          />
          <Knob
            label="初始止损"
            value={params.stopMult}
            display={`${params.stopMult.toFixed(1)} × ATR`}
            hint={stopMultHint(params)}
            min={1}
            max={10}
            step={0.5}
            onChange={(v) => set("stopMult", v)}
          />
          <Knob
            label="吊灯止损"
            value={params.trailMult}
            display={`${params.trailMult.toFixed(1)} × ATR`}
            hint="从最高价回撤这么多离场，浮盈越高自动收得越紧。Pine 原值 5.5。"
            min={1}
            max={14}
            step={0.5}
            onChange={(v) => set("trailMult", v)}
          />
          <div>
            <Group justify="space-between" mb={4}>
              <Text size="sm" fw={600} c="gray.2">
                R 倍数止盈
              </Text>
              <Text size="sm" ff="monospace" c="gray.4">
                {params.takeProfitR == null ? "不止盈（原版）" : `${params.takeProfitR} R`}
              </Text>
            </Group>
            <SegmentedControl
              fullWidth
              size="xs"
              value={params.takeProfitR == null ? "off" : String(params.takeProfitR)}
              onChange={(v) => set("takeProfitR", v === "off" ? null : Number(v))}
              data={[
                { label: "关", value: "off" },
                { label: "1R", value: "1" },
                { label: "2R", value: "2" },
                { label: "3R", value: "3" },
                { label: "5R", value: "5" },
                { label: "8R", value: "8" },
              ]}
            />
            <Text size="xs" c="dimmed" mt={6}>
              原策略没有止盈。标普池上截断右尾通常减收益；Small Fund 近五年平台组用的是 1R。
            </Text>
          </div>
          <div>
            <Group justify="space-between" mb={4}>
              <Text size="sm" fw={600} c="gray.2">
                RPS 定权重
              </Text>
              <Text size="sm" ff="monospace" c="gray.4">
                {params.rpsWeightPower == null ? "等权" : `k=${params.rpsWeightPower}`}
              </Text>
            </Group>
            <SegmentedControl
              fullWidth
              size="xs"
              value={params.rpsWeightPower == null ? "off" : String(params.rpsWeightPower)}
              onChange={(v) =>
                set("rpsWeightPower", v === "off" ? null : Number(v))
              }
              data={[
                { label: "等权", value: "off" },
                { label: "k=1", value: "1" },
                { label: "k=2", value: "2" },
              ]}
            />
            <Text size="xs" c="dimmed" mt={6}>
              仓位 ∝ (开仓 RPS/100)^k，当日持仓归一化到满仓。k=1 是 Small Fund 默认。
            </Text>
          </div>
          <div>
            <Group justify="space-between" mb={4}>
              <Text size="sm" fw={600} c="gray.2">
                单笔风险预算
              </Text>
              <Text size="sm" ff="monospace" c="gray.4">
                {params.riskBudgetPct == null ? "每日等权" : `${params.riskBudgetPct}% 净值`}
              </Text>
            </Group>
            <SegmentedControl
              fullWidth
              size="xs"
              value={params.riskBudgetPct == null ? "off" : String(params.riskBudgetPct)}
              onChange={(v) => set("riskBudgetPct", v === "off" ? null : Number(v))}
              data={[
                { label: "等权", value: "off" },
                { label: "0.8%", value: "0.8" },
                { label: "1.6%", value: "1.6" },
                { label: "3%", value: "3" },
                { label: "5%", value: "5" },
              ]}
            />
            <Text size="xs" c="dimmed" mt={6}>
              仓位 = 预算 ÷ 止损距离，止损远的少下钱，权重之和封顶 100%。
              规格给的 0.8% 是基金级政策，本策略并发持仓不够，取它会有近一半时间在现金里，
              而基准恒满仓——看敞口那一行再读超额。
            </Text>
          </div>
          <div>
            <Group justify="space-between" mb={4}>
              <Text size="sm" fw={600} c="gray.2">
                RPS 转弱离场
              </Text>
              <Text size="sm" ff="monospace" c="gray.4">
                {params.rpsExit == null ? "不启用（原版）" : `跌破 ${params.rpsExit}`}
              </Text>
            </Group>
            <SegmentedControl
              fullWidth
              size="xs"
              value={params.rpsExit == null ? "off" : String(params.rpsExit)}
              onChange={(v) => set("rpsExit", v === "off" ? null : Number(v))}
              data={[
                { label: "关", value: "off" },
                { label: "10", value: "10" },
                { label: "20", value: "20" },
                { label: "30", value: "30" },
                { label: "40", value: "40" },
              ]}
            />
            <Text size="xs" c="dimmed" mt={6}>
              入场闸门问「现在够不够强」，这个问「还够不够强」。原策略开仓后完全不看 RPS。
              实测收益有限：RPS 由 1~12 个月的回看加权而成，转向很慢，
              吊灯止损已经先把仓位打掉了——出场上快的打败慢的。
            </Text>
          </div>

          <Group gap="xl">
            <Switch
              size="sm"
              label="一买"
              checked={params.useBuy1}
              onChange={(e) => set("useBuy1", e.currentTarget.checked)}
            />
            <Switch
              size="sm"
              label="二买"
              checked={params.useBuy2}
              onChange={(e) => set("useBuy2", e.currentTarget.checked)}
            />
          </Group>
        </div>
        <Button
          size="compact-xs"
          variant="subtle"
          color="gray"
          mt="md"
          onClick={() => setShowMore((v) => !v)}
        >
          {showMore ? "收起过滤项" : "流动性 / RSI / Vegas"}
        </Button>
      </Card>

      {showMore ? (
      <>
      <Card
        title={
          <Stack gap={2}>
            <Text size="sm" fw={700} c="gray.1">
              第一阶段 · 标的池初筛
            </Text>
            <Text size="xs" c="dimmed">
              只影响入场资格，不改变基准——基准始终是完整时点成分池的等权买入持有
            </Text>
          </Stack>
        }
        action={
          <Button
            size="compact-xs"
            variant="default"
            onClick={() => setParams((p) => ({ ...p, ...SPEC_FILTERS }))}
          >
            套用规格阈值
          </Button>
        }
      >
        <div className="grid gap-x-10 gap-y-6 md:grid-cols-2">
          <Knob
            label="50 日日均成交额"
            value={params.minAdtvUsd / 1e6}
            display={params.minAdtvUsd === 0 ? "不筛选" : `≥ $${params.minAdtvUsd / 1e6}M`}
            hint="规格原值 $3000万。标普成分内部这条并非空转：成交额偏低的成分股（如 HUBB 中位约 $30M）会被切掉，早年名义成交额普遍更低，被切的更多。"
            min={0}
            max={200}
            step={10}
            onChange={(v) => set("minAdtvUsd", v * 1e6)}
          />
          <div>
            <Group justify="space-between" mb={4}>
              <Text size="sm" fw={600} c="gray.2">
                最低收盘价
              </Text>
              <Text size="sm" ff="monospace" c="gray.4">
                {params.minPrice === 0 ? "不筛选" : `≥ $${params.minPrice}`}
              </Text>
            </Group>
            <SegmentedControl
              fullWidth
              size="xs"
              value={String(params.minPrice)}
              onChange={(v) => set("minPrice", Number(v))}
              data={[
                { label: "关", value: "0" },
                { label: "$5", value: "5" },
                { label: "$10", value: "10" },
                { label: "$20", value: "20" },
              ]}
            />
            <Text size="xs" c="dimmed" mt={6}>
              规格原值 $5，用于剔除仙股。标普成分里几乎没有低于 $5 的，
              这条在本池内基本空转，留着是为了口径完整。
            </Text>
          </div>

          <div className="md:col-span-2">
            <Switch
              size="sm"
              label="要求收盘价站上 MA200 或 MA850"
              checked={params.requireTrend}
              onChange={(e) => set("requireTrend", e.currentTarget.checked)}
            />
            <Text size="xs" c="dimmed" mt={6}>
              规格里我们原先完全没有的一条，也是我认为最值得测的一条。用「或」而非「且」
              是照抄规格：站上 850 日线却跌破 200 日线，正是长期牛股回踩中继的形态，
              恰好是抄底信号想要的场景。它针对的是本策略已知的最大弱点——
              在 V 型反转里被反复打（2009 超额 −31.27%、2025 −14.83%）。
            </Text>
          </div>
        </div>
      </Card>

      <Card
        title={
          <Stack gap={2}>
            <Text size="sm" fw={700} c="gray.1">
              买点过滤器 · RSI / Vegas
            </Text>
            <Text size="xs" c="dimmed">
              只挡入场，不改出场。关掉等于不筛；周期改了当场重算，不必重载面板
            </Text>
          </Stack>
        }
        action={
          <Group gap="xs">
            <Button
              size="compact-xs"
              variant="default"
              onClick={() =>
                setParams((p) => ({
                  ...p,
                  requireRsi: true,
                  minRsi: 30,
                  requireVegas: true,
                  ...VEGAS_SPEC,
                }))
              }
            >
              Small Fund 规格
            </Button>
            <Button
              size="compact-xs"
              variant="default"
              onClick={() =>
                setParams((p) => ({ ...p, requireVegas: true, ...VEGAS_SHORT }))
              }
            >
              Vegas 200/250
            </Button>
          </Group>
        }
      >
        <div className="grid gap-x-10 gap-y-6 md:grid-cols-2">
          <div>
            <Switch
              size="sm"
              label="RSI 过滤"
              checked={params.requireRsi}
              onChange={(e) => set("requireRsi", e.currentTarget.checked)}
            />
            <Text size="xs" c="dimmed" mt={6} mb="sm">
              标准 14 日 RSI 低于门槛则不入场。规格值 30，用来避开超卖末端以外的钝化区。
            </Text>
            <Knob
              label="RSI 门槛"
              value={params.minRsi}
              display={`> ${params.minRsi}`}
              hint={params.requireRsi ? "低于此值的买点作废。" : "开关关掉时这条不起作用。"}
              min={10}
              max={70}
              step={1}
              onChange={(v) => set("minRsi", v)}
            />
          </div>

          <div>
            <Switch
              size="sm"
              label="Vegas 通道"
              checked={params.requireVegas}
              onChange={(e) => set("requireVegas", e.currentTarget.checked)}
            />
            <Text size="xs" c="dimmed" mt={6}>
              min(EMA短A, 短B) 必须大于 max(EMA长A, 长B)。规格是 166/169 在 576/676
              之上。长周期未播种的新股会被排除，不是放行。
            </Text>
            <div className="mt-3 grid grid-cols-2 gap-3">
              <PeriodInput
                label="短 A"
                value={params.vegasFastA}
                onChange={(v) => set("vegasFastA", v)}
              />
              <PeriodInput
                label="短 B"
                value={params.vegasFastB}
                onChange={(v) => set("vegasFastB", v)}
              />
              <PeriodInput
                label="长 A"
                value={params.vegasSlowA}
                onChange={(v) => set("vegasSlowA", v)}
              />
              <PeriodInput
                label="长 B"
                value={params.vegasSlowB}
                onChange={(v) => set("vegasSlowB", v)}
              />
            </div>
            <Text size="xs" c="dimmed" mt={6}>
              {params.requireVegas
                ? `当前：min(EMA${params.vegasFastA}, EMA${params.vegasFastB}) > max(EMA${params.vegasSlowA}, EMA${params.vegasSlowB})`
                : "开关关掉时周期数字只是备着，不参与判定。"}
            </Text>
          </div>
        </div>
      </Card>
      </>
      ) : null}

      {error ? (
        <Card>
          <Text size="sm" c="red.4">
            {error}
          </Text>
        </Card>
      ) : null}

      <Text size="xs" c="dimmed">
        已试 {trialCount} 组
        {result?.outOfSample.portfolio.days === 0
          ? " · 未切分保留区"
          : ` · 点开保留区 ${peekCount} 次`}
        。默认是网格里挑过的平台组，不是中立起点。
      </Text>

      {result ? (
        <>
          <div
            className={
              result.outOfSample.portfolio.days === 0
                ? "grid gap-4"
                : "grid gap-4 lg:grid-cols-2"
            }
          >
            <WindowCard
              window={result.inSample}
              excess={inExcess}
              spy={spyMultiple(result.book, result.inSample.from, result.inSample.to)}
              hidden={false}
              accent="训练区"
            />
            {result.outOfSample.portfolio.days > 0 ? (
              <WindowCard
                window={result.outOfSample}
                excess={outExcess}
                spy={spyMultiple(result.book, result.outOfSample.from, result.outOfSample.to)}
                hidden={!showOos}
                accent="保留区"
                onReveal={revealOos}
                revealed={showOos}
              />
            ) : null}
          </div>

          <LabFundChart
            book={result.book}
            holdings={result.holdings}
            ytd={result.ytd}
            trades={result.trades}
            splitDate={result.config.splitDate}
            maskAfterSplit={!showOos}
            onPick={(symbol, entryDate) => setChartTarget({ symbol, entryDate })}
          />

          <YearTable rows={result.byYear} ytdYear={result.ytd?.year ?? null} maskOos={!showOos} />

          <TradeBlotter
            trades={result.trades}
            maskOos={!showOos}
            onPickTrade={setChartTarget}
          />

          <Text size="xs" c="dimmed">
            {result.indexLabel} {result.universeSize} 只 · {result.signalCount} 个信号 · 不含费
          </Text>
        </>
      ) : loading ? (
        <Card>
          <Group gap="sm">
            <Loader size="sm" color="gray" />
            <Text size="sm" c="dimmed">
              首次载入要预处理全池约 300 万根日线（十几秒），之后每次调参约 450 毫秒。
            </Text>
          </Group>
        </Card>
      ) : null}

      <LabSymbolChart
        target={chartTarget}
        request={chartRequest}
        onClose={() => setChartTarget(null)}
      />
    </Stack>
  );
}

function PeriodInput({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <NumberInput
      label={label}
      size="xs"
      min={5}
      max={900}
      step={1}
      clampBehavior="strict"
      value={value}
      onChange={(v) => {
        if (typeof v === "number") onChange(v);
      }}
    />
  );
}

function Knob({
  label,
  value,
  display,
  hint,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  value: number;
  display: string;
  hint: string;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
}) {
  return (
    <div>
      <Group justify="space-between" mb={4}>
        <Text size="sm" fw={600} c="gray.2">
          {label}
        </Text>
        <Text size="sm" ff="monospace" c="gray.4">
          {display}
        </Text>
      </Group>
      <Slider
        value={value}
        onChange={onChange}
        min={min}
        max={max}
        step={step}
        size="sm"
        color="gray"
        label={null}
      />
      <Text size="xs" c="dimmed" mt={6}>
        {hint}
      </Text>
    </div>
  );
}

function WindowCard({
  window: w,
  excess,
  spy,
  hidden,
  accent,
  onReveal,
  revealed,
}: {
  window: WindowResult;
  excess: number;
  spy: number | null;
  hidden: boolean;
  accent: string;
  onReveal?: () => void;
  revealed?: boolean;
}) {
  return (
    <Card
      title={
        <Stack gap={2}>
          <Text size="sm" fw={700} c="gray.1">
            {w.label}
          </Text>
          <Text size="xs" c="dimmed">
            {w.from} → {w.to} · {accent}
          </Text>
        </Stack>
      }
      action={
        onReveal ? (
          <Button
            size="compact-xs"
            variant="default"
            leftSection={
              revealed ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />
            }
            onClick={onReveal}
          >
            {revealed ? "盖上" : "点开"}
          </Button>
        ) : null
      }
    >
      <div className={hidden ? "pointer-events-none select-none blur-md" : undefined}>
        <div className="mb-4">
          <div className="font-mono text-2xl" style={{ color: tone(excess) }}>
            {pct(excess)}
          </div>
          <div className="text-xs text-zinc-500">年化超额 vs 同池</div>
        </div>

        <Table verticalSpacing={4} horizontalSpacing={0} withRowBorders={false} fz="xs">
          <Table.Tbody>
            <Row label="年化" a={pct(w.portfolio.cagrPct)} b={pct(w.benchmark.cagrPct)} />
            <Row
              label="净值"
              a={`${w.portfolio.equity.toFixed(2)}x`}
              b={`${w.benchmark.equity.toFixed(2)}x`}
            />
            {spy != null ? (
              <Table.Tr>
                <Table.Td c="dimmed">标普</Table.Td>
                <Table.Td ta="right" ff="monospace" style={{ color: "#d97706" }} colSpan={2}>
                  {spy.toFixed(2)}x
                </Table.Td>
              </Table.Tr>
            ) : null}
            <Row
              label="回撤"
              a={`-${w.portfolio.maxDrawdownPct.toFixed(1)}%`}
              b={`-${w.benchmark.maxDrawdownPct.toFixed(1)}%`}
            />
          </Table.Tbody>
        </Table>

        <div className="mt-4 grid grid-cols-3 gap-3 border-t border-[var(--border-subtle)] pt-3 text-xs">
          <Stat label="成交" value={`${w.trade.trades} 笔`} />
          <Stat label="胜率" value={`${w.trade.winRatePct.toFixed(1)}%`} />
          <Stat label="盈亏比" value={w.trade.profitFactor.toFixed(2)} />
        </div>
      </div>
    </Card>
  );
}

function Row({ label, a, b }: { label: string; a: string; b: string }) {
  return (
    <Table.Tr>
      <Table.Td c="dimmed">{label}</Table.Td>
      <Table.Td ta="right" ff="monospace" c="gray.1">
        {a}
      </Table.Td>
      <Table.Td ta="right" ff="monospace" c="dimmed">
        {b}
      </Table.Td>
    </Table.Tr>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="font-mono text-zinc-200">{value}</div>
      <div className="text-zinc-500">{label}</div>
    </div>
  );
}

/**
 * `stop` 标「吊灯」而不是「止损」：生效止损是 max(初始止损, 吊灯)，而吊灯跟着
 * 持仓最高价上抬、浮盈越大收得越紧，所以它同样会在**盈利**时触发——那正是移动
 * 止损锁利润的方式。叫「止损」会让 +18% 的离场看起来自相矛盾。
 *
 * 这一列答的是「哪条规则触发了离场」，不是「这笔赚没赚」，后者在收益列。
 */
const EXIT_LABEL: Record<ExitReason, string> = {
  stop: "吊灯",
  target: "止盈",
  rsWeak: "转弱",
  veto: "否决",
};

type SortKey = "entryDate" | "pnlPct" | "r" | "barsHeld";

const PAGE_SIZE = 50;

function TradeBlotter({
  trades,
  maskOos,
  onPickTrade,
}: {
  trades: TradeRow[];
  maskOos: boolean;
  onPickTrade: (target: ChartTarget) => void;
}) {
  const [scope, setScope] = useState<"all" | "in" | "out">("all");
  const [reason, setReason] = useState<"all" | ExitReason>("all");
  const [sortKey, setSortKey] = useState<SortKey>("entryDate");
  const [desc, setDesc] = useState(true);
  const [page, setPage] = useState(1);

  const rows = useMemo(() => {
    // 盖住保留区时整行剔除，而不是打码——和净值曲线一致，遮挡挡不住眼睛
    let out = maskOos ? trades.filter((t) => !t.isOutOfSample) : trades;
    if (scope !== "all") out = out.filter((t) => t.isOutOfSample === (scope === "out"));
    if (reason !== "all") out = out.filter((t) => t.exitReason === reason);

    const dir = desc ? -1 : 1;
    return [...out].sort((a, b) => {
      const x = a[sortKey];
      const y = b[sortKey];
      return x === y ? 0 : (x < y ? -1 : 1) * dir;
    });
  }, [trades, maskOos, scope, reason, sortKey, desc]);

  const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const shown = rows.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  const sortBy = (key: SortKey) => {
    if (key === sortKey) setDesc((v) => !v);
    else {
      setSortKey(key);
      setDesc(true);
    }
    setPage(1);
  };

  const exportCsv = () => {
    const head = [
      "入场日",
      "标的",
      "信号",
      "入场价",
      "出场日",
      "出场价",
      "持仓根数",
      "收益%",
      "R倍数",
      "1R%",
      "离场原因",
      "窗口",
    ];
    const body = rows.map((t) =>
      [
        t.entryDate,
        t.symbol,
        t.sigType === 1 ? "一买" : "二买",
        t.entryPrice.toFixed(4),
        t.exitDate,
        t.exitPrice.toFixed(4),
        t.barsHeld,
        t.pnlPct.toFixed(4),
        t.r.toFixed(4),
        t.riskPct.toFixed(4),
        EXIT_LABEL[t.exitReason],
        t.isOutOfSample ? "保留区" : "训练区",
      ].join(","),
    );

    // \ufeff 是 BOM：没有它 Excel 会把 UTF-8 中文读成乱码
    const url = URL.createObjectURL(
      new Blob([`\ufeff${[head.join(","), ...body].join("\n")}`], {
        type: "text/csv;charset=utf-8",
      }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = `trades-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const wins = rows.filter((t) => t.pnlPct > 0).length;

  return (
    <Card
      title={
        <Stack gap={2}>
          <Text size="sm" fw={700} c="gray.1">
            成交明细
          </Text>
          <Text size="xs" c="dimmed">
            {rows.length} 笔
            {rows.length > 0
              ? ` · 胜 ${wins} 负 ${rows.length - wins} · 均值 ${pct(
                  rows.reduce((a, t) => a + t.pnlPct, 0) / rows.length,
                )}`
              : ""}
            {maskOos ? " · 保留区已剔除" : ""}
          </Text>
        </Stack>
      }
      action={
        <Button
          size="compact-xs"
          variant="default"
          leftSection={<Download className="h-3 w-3" />}
          onClick={exportCsv}
          disabled={rows.length === 0}
        >
          导出 CSV
        </Button>
      }
    >
      <Group gap="sm" mb="sm">
        <SegmentedControl
          size="xs"
          value={maskOos ? "in" : scope}
          disabled={maskOos}
          onChange={(v) => {
            setScope(v as typeof scope);
            setPage(1);
          }}
          data={[
            { label: "全部", value: "all" },
            { label: "训练区", value: "in" },
            { label: "保留区", value: "out" },
          ]}
        />
        <SegmentedControl
          size="xs"
          value={reason}
          onChange={(v) => {
            setReason(v as typeof reason);
            setPage(1);
          }}
          data={[
            { label: "全部离场", value: "all" },
            { label: EXIT_LABEL.stop, value: "stop" },
            { label: EXIT_LABEL.target, value: "target" },
            { label: EXIT_LABEL.rsWeak, value: "rsWeak" },
          ]}
        />
      </Group>

      <div className="overflow-x-auto">
        <Table verticalSpacing={5} fz="xs" highlightOnHover striped stripedColor="#18181b">
          <Table.Thead>
            <Table.Tr>
              <SortTh label="入场日" k="entryDate" active={sortKey} desc={desc} onSort={sortBy} />
              <Table.Th>标的</Table.Th>
              <Table.Th>信号</Table.Th>
              <Table.Th ta="right">入场价</Table.Th>
              <Table.Th>出场日</Table.Th>
              <Table.Th ta="right">出场价</Table.Th>
              <SortTh
                label="持仓"
                k="barsHeld"
                active={sortKey}
                desc={desc}
                onSort={sortBy}
                right
              />
              <SortTh label="收益" k="pnlPct" active={sortKey} desc={desc} onSort={sortBy} right />
              <SortTh label="R" k="r" active={sortKey} desc={desc} onSort={sortBy} right />
              <Table.Th ta="right">1R</Table.Th>
              <Table.Th>离场</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {shown.map((t) => (
              <Table.Tr key={`${t.symbol}-${t.entryDate}-${t.exitDate}`}>
                <Table.Td ff="monospace" c="gray.4">
                  {t.entryDate}
                </Table.Td>
                <Table.Td ff="monospace" fw={600} c="gray.1">
                  <button
                    type="button"
                    onClick={() => onPickTrade({ symbol: t.symbol, entryDate: t.entryDate })}
                    className="underline decoration-dotted decoration-zinc-600 underline-offset-4 hover:text-white hover:decoration-zinc-300"
                    title={`看这一笔的 K 线与风控线`}
                  >
                    {t.symbol}
                  </button>
                </Table.Td>
                <Table.Td>
                  <Badge size="xs" variant="light" color={t.sigType === 1 ? "blue" : "grape"}>
                    {t.sigType === 1 ? "一买" : "二买"}
                  </Badge>
                </Table.Td>
                <Table.Td ta="right" ff="monospace" c="gray.3">
                  {t.entryPrice.toFixed(2)}
                </Table.Td>
                <Table.Td ff="monospace" c="gray.5">
                  {t.exitDate}
                </Table.Td>
                <Table.Td ta="right" ff="monospace" c="gray.3">
                  {t.exitPrice.toFixed(2)}
                </Table.Td>
                <Table.Td ta="right" ff="monospace" c="dimmed">
                  {t.barsHeld}
                </Table.Td>
                <Table.Td ta="right" ff="monospace" style={{ color: tone(t.pnlPct) }}>
                  {pct(t.pnlPct)}
                </Table.Td>
                <Table.Td ta="right" ff="monospace" style={{ color: tone(t.r) }}>
                  {t.r >= 0 ? "+" : ""}
                  {t.r.toFixed(2)}
                </Table.Td>
                <Table.Td ta="right" ff="monospace" c="dimmed">
                  {t.riskPct.toFixed(1)}%
                </Table.Td>
                <Table.Td>
                  {/* 颜色跟盈亏走：吊灯离场既可能是砍亏也可能是收利润，写死红色会误读 */}
                  <Badge size="xs" variant="light" color={t.pnlPct >= 0 ? "teal" : "red"}>
                    {EXIT_LABEL[t.exitReason]}
                  </Badge>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </div>

      {rows.length === 0 ? (
        <Text size="xs" c="dimmed" ta="center" py="lg">
          当前筛选下没有成交
        </Text>
      ) : null}

      {totalPages > 1 ? (
        <Group justify="space-between" mt="sm">
          <Text size="xs" c="dimmed" ff="monospace">
            {(safePage - 1) * PAGE_SIZE + 1}–{Math.min(safePage * PAGE_SIZE, rows.length)} /{" "}
            {rows.length}
          </Text>
          <Pagination
            size="xs"
            color="gray"
            value={safePage}
            onChange={setPage}
            total={totalPages}
            siblings={1}
          />
        </Group>
      ) : null}

      <Text size="xs" c="dimmed" mt="sm">
        入场价与出场价均为<b>次日开盘价</b>——点火与出场条件全部取自收盘价，而收盘价要等
        收盘之后才存在，所以两条腿都只能等到次日开盘才成交。「持仓根数」为进出场之间的
        交易日数。「1R」是开仓时止损距离占开仓价的比例，收益除以它就是 R 倍数；导出的 CSV
        保留四位小数，页面上做了取整。
      </Text>
    </Card>
  );
}

function SortTh({
  label,
  k,
  active,
  desc,
  onSort,
  right,
}: {
  label: string;
  k: SortKey;
  active: SortKey;
  desc: boolean;
  onSort: (k: SortKey) => void;
  right?: boolean;
}) {
  const on = active === k;
  return (
    <Table.Th ta={right ? "right" : undefined}>
      <button
        type="button"
        onClick={() => onSort(k)}
        className={`inline-flex items-center gap-1 hover:text-zinc-200 ${on ? "text-zinc-200" : ""}`}
      >
        {label}
        {on ? (
          desc ? (
            <ArrowDown className="h-3 w-3" />
          ) : (
            <ArrowUp className="h-3 w-3" />
          )
        ) : (
          <ArrowUpDown className="h-3 w-3 opacity-30" />
        )}
      </button>
    </Table.Th>
  );
}

function YearTable({
  rows,
  ytdYear,
  maskOos,
}: {
  rows: Result["byYear"];
  ytdYear: number | null;
  maskOos: boolean;
}) {
  return (
    <Card title="分年度">
      <Table verticalSpacing={6} fz="xs" highlightOnHover>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>年份</Table.Th>
            <Table.Th ta="right">策略</Table.Th>
            <Table.Th ta="right">同池</Table.Th>
            <Table.Th ta="right">标普</Table.Th>
            <Table.Th ta="right">超额</Table.Th>
            <Table.Th ta="right">成交</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {rows.map((r) => {
            const masked = maskOos && r.isOutOfSample;
            const excess = r.strategyPct - r.benchmarkPct;
            return (
              <Table.Tr key={r.year}>
                <Table.Td ff="monospace" c={r.isOutOfSample ? "gray.5" : "gray.2"}>
                  {r.year}
                  {r.year === ytdYear ? (
                    <Badge size="xs" variant="light" color="blue" ml={6}>
                      YTD
                    </Badge>
                  ) : null}
                  {r.isOutOfSample ? (
                    <Badge size="xs" variant="light" color="gray" ml={6}>
                      保留
                    </Badge>
                  ) : null}
                </Table.Td>
                {masked ? (
                  <Table.Td colSpan={5} ta="right" c="dimmed">
                    已隐藏
                  </Table.Td>
                ) : (
                  <>
                    <Table.Td ta="right" ff="monospace" style={{ color: tone(r.strategyPct) }}>
                      {pct(r.strategyPct)}
                    </Table.Td>
                    <Table.Td ta="right" ff="monospace" c="dimmed">
                      {pct(r.benchmarkPct)}
                    </Table.Td>
                    <Table.Td ta="right" ff="monospace" style={{ color: "#d97706" }}>
                      {r.spyPct == null ? "—" : pct(r.spyPct)}
                    </Table.Td>
                    <Table.Td ta="right" ff="monospace" style={{ color: tone(excess) }}>
                      {pct(excess)}
                    </Table.Td>
                    <Table.Td ta="right" ff="monospace" c="dimmed">
                      {r.trades}
                    </Table.Td>
                  </>
                )}
              </Table.Tr>
            );
          })}
        </Table.Tbody>
      </Table>
    </Card>
  );
}
