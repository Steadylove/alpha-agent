"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Badge,
  Button,
  Group,
  Loader,
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
  TriangleAlert,
} from "lucide-react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { Card } from "@/components/Card";

const POS = "#089981";
const NEG = "#f23645";
const BENCH = "#71717a";

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
    isOutOfSample: boolean;
  }[];
  equity: { date: string; strategy: number; benchmark: number }[];
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
  useBuy1: boolean;
  useBuy2: boolean;
  minAdtvUsd: number;
  minPrice: number;
  requireTrend: boolean;
};

/** 与 engine.ts 的 DEFAULT_BACKTEST_CONFIG 保持一致，来源见那里的注释。 */
const DEFAULTS: Params = {
  rpsMin: 30,
  rpsExit: null,
  stopMult: 3.5,
  trailMult: 2.5,
  takeProfitR: 3,
  useBuy1: true,
  useBuy2: false,
  minAdtvUsd: 0,
  minPrice: 0,
  requireTrend: false,
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

type IndexKey = "UNION" | "SP500" | "NDX100";

/**
 * 标的池不并入 Params：它决定载入哪批数据，而 Params 是在同一批数据上重算的
 * 引擎参数。并进去的话，「Pine 原值」「复原」这类整体替换会把池子一起重置。
 */
const POOLS: { value: IndexKey; label: string }[] = [
  { value: "UNION", label: "两者并集" },
  { value: "SP500", label: "标普 500" },
  { value: "NDX100", label: "纳斯达克 100" },
];

const pct = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;
const tone = (v: number) => (v >= 0 ? POS : NEG);

export function LabWorkbench() {
  const [params, setParams] = useState<Params>(DEFAULTS);
  const [index, setIndex] = useState<IndexKey>("UNION");
  const [result, setResult] = useState<Result | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showOos, setShowOos] = useState(false);

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
              onClick={() => setParams(DEFAULTS)}
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
              onChange={(v) => setIndex(v as IndexKey)}
              data={POOLS}
            />
            {result ? (
              <Text size="xs" c="dimmed" ff="monospace">
                池内 {result.universeSize} 只
              </Text>
            ) : null}
          </Group>
          <Text size="xs" c="dimmed">
            三个池子都用时点成分，不含后见之明。换池子同时换掉基准：基准恒为
            <b>同一池子</b>的等权买入持有，所以「超额」在不同池子之间不可直接比大小。
            池子的作用是给 RPS 提供候选，候选越多它越有得选；单用纳斯达克 100
            只有约 190 只，仓位常填不满，而且它的成分规则是市值与上市地、不衡量强弱。
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
            hint={
              params.stopMult >= params.trailMult
                ? `比吊灯宽，因此永不触发——退出条件是「收盘低于止损或低于吊灯」，吊灯位更高会先触发。${params.takeProfitR == null ? "此时拖动本滑块不会有任何变化。" : "此时它只通过定义 1R 影响止盈距离。"}`
                : "比吊灯紧，是真正生效的初始止损。同时定义 1R。Pine 原值 4.0。"
            }
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
              原策略没有止盈。它的正期望几乎全在右尾，截断右尾大概率减少收益——
              这个开关的用途是让这件事被测量，而不是假定它有好处。
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
      </Card>

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
              在 V 型反转里被反复打（2009 超额 −17.29%、2025 −13.76%）。
            </Text>
          </div>
        </div>
      </Card>

      {error ? (
        <Card>
          <Text size="sm" c="red.4">
            {error}
          </Text>
        </Card>
      ) : null}

      <Card>
        <Group gap="xs" wrap="nowrap">
          <TriangleAlert className="h-4 w-4 shrink-0 text-amber-500" />
          <Text size="xs" c="dimmed">
            <b className="text-zinc-200">默认参数不是中立起点</b>——它是在 1200
            组网格上搜出来的，选参时看过保留区，所以保留区的数字只能当上界看，不是干净的样本外估计。
            点「Pine 原值」可以看未经搜索的原始配置。本次会话已试{" "}
            <b className="text-zinc-200">{trialCount}</b> 组参数，
            点开保留区 <b className="text-zinc-200">{peekCount}</b> 次。
            试的组数越多，训练区里「最好那一组」来自偶然的概率越高：二十组里冒出一个
            看着漂亮的结果是常态，不是发现。判断一组参数是否可信，看的是训练区与保留区
            的超额**同号且量级相近**，而不是任何单个窗口的数字有多好。
          </Text>
        </Group>
      </Card>

      {result ? (
        <>
          <div className="grid gap-4 lg:grid-cols-2">
            <WindowCard
              window={result.inSample}
              excess={inExcess}
              hidden={false}
              accent="训练区 · 可以在这里调参"
            />
            <WindowCard
              window={result.outOfSample}
              excess={outExcess}
              hidden={!showOos}
              accent="保留区 · 只用来验证，不要用来挑参数"
              onReveal={revealOos}
              revealed={showOos}
            />
          </div>

          <EquityChart
            data={result.equity}
            splitDate={result.config.splitDate}
            maskAfterSplit={!showOos}
          />

          <YearTable rows={result.byYear} maskOos={!showOos} />

          <TradeBlotter trades={result.trades} maskOos={!showOos} />

          <Text size="xs" c="dimmed">
            {result.indexLabel}池内 {result.universeSize} 只，采纳信号 {result.signalCount} 个。
            基准为同一时点成分池的等权买入持有，与策略吃同一批数据、同一个窗口，
            因此二者的幸存者偏差大体相抵——可信的是二者之差，不是任何一方的绝对水平。
            未计入手续费、滑点与冲击成本。
          </Text>
        </>
      ) : loading ? (
        <Card>
          <Group gap="sm">
            <Loader size="sm" color="gray" />
            <Text size="sm" c="dimmed">
              首次载入要预处理全池约 300 万根日线（十几秒），之后每次调参约 250 毫秒。
            </Text>
          </Group>
        </Card>
      ) : null}
    </Stack>
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
  hidden,
  accent,
  onReveal,
  revealed,
}: {
  window: WindowResult;
  excess: number;
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
          <div className="text-xs text-zinc-500">年化超额（策略 − 同池基准）</div>
        </div>

        <Table verticalSpacing={4} horizontalSpacing={0} withRowBorders={false} fz="xs">
          <Table.Tbody>
            <Row label="年化" a={pct(w.portfolio.cagrPct)} b={pct(w.benchmark.cagrPct)} />
            <Row
              label="净值"
              a={`${w.portfolio.equity.toFixed(2)}x`}
              b={`${w.benchmark.equity.toFixed(2)}x`}
            />
            <Row
              label="最大回撤"
              a={`-${w.portfolio.maxDrawdownPct.toFixed(1)}%`}
              b={`-${w.benchmark.maxDrawdownPct.toFixed(1)}%`}
            />
            <Row
              label="年化波动"
              a={`${w.portfolio.volPct.toFixed(1)}%`}
              b={`${w.benchmark.volPct.toFixed(1)}%`}
            />
            <Row label="持仓日占比" a={`${w.portfolio.investedDayPct.toFixed(0)}%`} b="100%" />
          </Table.Tbody>
        </Table>

        <div className="mt-4 grid grid-cols-3 gap-3 border-t border-[var(--border-subtle)] pt-3 text-xs">
          <Stat label="成交" value={`${w.trade.trades} 笔`} />
          <Stat label="胜率" value={`${w.trade.winRatePct.toFixed(1)}%`} />
          <Stat label="盈亏比" value={w.trade.profitFactor.toFixed(2)} />
          <Stat label="每笔均值" value={pct(w.trade.meanPnlPct)} />
          <Stat label="每笔中位" value={pct(w.trade.medianPnlPct)} />
          <Stat label="平均 R" value={w.trade.meanR.toFixed(2)} />
          <Stat label="平均持仓" value={`${w.trade.avgBarsHeld.toFixed(0)} 根`} />
          <Stat label="最差一笔" value={pct(w.trade.worstPnlPct)} />
          <Stat
            label={w.trade.exits.rsWeak > 0 ? "止损/止盈/转弱" : "止损/止盈"}
            value={
              w.trade.exits.rsWeak > 0
                ? `${w.trade.exits.stop}/${w.trade.exits.target}/${w.trade.exits.rsWeak}`
                : `${w.trade.exits.stop}/${w.trade.exits.target}`
            }
          />
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

function EquityChart({
  data,
  splitDate,
  maskAfterSplit,
}: {
  data: { date: string; strategy: number; benchmark: number }[];
  splitDate: string;
  maskAfterSplit: boolean;
}) {
  // 盖住保留区时直接截断数据，而不是视觉遮挡——遮挡挡不住眼睛
  const shown = useMemo(
    () => (maskAfterSplit ? data.filter((p) => p.date < splitDate) : data),
    [data, maskAfterSplit, splitDate],
  );

  return (
    <Card
      title={
        <Stack gap={2}>
          <Text size="sm" fw={700} c="gray.1">
            净值曲线
          </Text>
          <Text size="xs" c="dimmed">
            等权持有全部在仓标的，空仓日不计息 · 灰线为同池等权买入持有
            {maskAfterSplit ? " · 保留区已截断" : ""}
          </Text>
        </Stack>
      }
    >
      <div style={{ height: 300 }}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={shown} margin={{ top: 4, right: 8, bottom: 0, left: -8 }}>
            <CartesianGrid stroke="#27272a" vertical={false} />
            <XAxis
              dataKey="date"
              tick={{ fill: "#71717a", fontSize: 11 }}
              tickLine={false}
              axisLine={{ stroke: "#27272a" }}
              minTickGap={56}
              tickFormatter={(d: string) => d.slice(0, 7)}
            />
            <YAxis
              scale="log"
              domain={["auto", "auto"]}
              tick={{ fill: "#71717a", fontSize: 11 }}
              tickLine={false}
              axisLine={false}
              width={52}
              tickFormatter={(v: number) => `${v.toFixed(1)}x`}
            />
            <ReferenceLine y={1} stroke="#3f3f46" />
            {!maskAfterSplit ? (
              <ReferenceLine
                x={shown.find((p) => p.date >= splitDate)?.date}
                stroke="#a1a1aa"
                strokeDasharray="4 4"
                label={{ value: "保留区起点", fill: "#a1a1aa", fontSize: 10, position: "top" }}
              />
            ) : null}
            <Tooltip content={<EquityTooltip />} cursor={{ stroke: "#52525b" }} isAnimationActive={false} />
            <Line
              type="monotone"
              dataKey="benchmark"
              stroke={BENCH}
              strokeWidth={1.25}
              dot={false}
              isAnimationActive={false}
            />
            <Line
              type="monotone"
              dataKey="strategy"
              stroke={POS}
              strokeWidth={1.75}
              dot={false}
              isAnimationActive={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
      <Text size="xs" c="dimmed" mt="xs">
        纵轴为对数刻度：二十年的复利在线性刻度上会把早期的涨跌压成一条平线。
      </Text>
    </Card>
  );
}

function EquityTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: { payload: { date: string; strategy: number; benchmark: number } }[];
}) {
  const p = payload?.[0]?.payload;
  if (!active || !p) return null;

  return (
    <div className="rounded border border-[var(--border-strong)] bg-[var(--surface-hover)]/95 px-3 py-2 text-xs">
      <div className="font-mono text-zinc-400">{p.date}</div>
      <div className="mt-1 font-mono" style={{ color: POS }}>
        策略 {p.strategy.toFixed(2)}x
      </div>
      <div className="font-mono text-zinc-400">基准 {p.benchmark.toFixed(2)}x</div>
      <div className="font-mono" style={{ color: tone(p.strategy - p.benchmark) }}>
        差 {p.strategy >= p.benchmark ? "+" : ""}
        {(p.strategy - p.benchmark).toFixed(2)}x
      </div>
    </div>
  );
}

const EXIT_LABEL: Record<ExitReason, string> = {
  stop: "止损",
  target: "止盈",
  rsWeak: "转弱",
  veto: "否决",
};

const EXIT_COLOR: Record<ExitReason, string> = {
  stop: "red",
  target: "teal",
  rsWeak: "yellow",
  veto: "gray",
};

type SortKey = "entryDate" | "pnlPct" | "r" | "barsHeld";

const PAGE_SIZE = 50;

function TradeBlotter({ trades, maskOos }: { trades: TradeRow[]; maskOos: boolean }) {
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
            { label: "止损", value: "stop" },
            { label: "止盈", value: "target" },
            { label: "转弱", value: "rsWeak" },
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
                  {t.symbol}
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
                  <Badge size="xs" variant="light" color={EXIT_COLOR[t.exitReason]}>
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
        入场价与出场价均为当根收盘价——信号在收盘后才确认，用当根开盘或最高价成交是穿越。
        「1R」是开仓时止损距离占开仓价的比例，收益除以它就是 R 倍数；导出的 CSV
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
  maskOos,
}: {
  rows: Result["byYear"];
  maskOos: boolean;
}) {
  return (
    <Card title="分年度">
      <Table verticalSpacing={6} fz="xs" highlightOnHover>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>年份</Table.Th>
            <Table.Th ta="right">策略</Table.Th>
            <Table.Th ta="right">同池基准</Table.Th>
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
                  {r.isOutOfSample ? (
                    <Badge size="xs" variant="light" color="gray" ml={6}>
                      保留
                    </Badge>
                  ) : null}
                </Table.Td>
                {masked ? (
                  <Table.Td colSpan={4} ta="right" c="dimmed">
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
