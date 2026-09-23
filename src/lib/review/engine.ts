import type { Metric, Regime } from "./types";

export const ENGINE_VERSION = "market-state-v2" as const;
// 描述性初始阈值，未经收益寻优。任何调整须更换版本，不能回写信号上下文。
export const MARKET_RULES = {
  priceNoise: 0.2,
  strongPrice: 1,
  breadthHigh: 60,
  breadthLow: 40,
  breadthNoise: 5,
  breadthStrong: 15,
  vixNoise: 2,
  vixStrong: 5,
  relativeNoise: 0.3,
  sectorCountChange: 2,
  persistenceDays: 3,
  persistenceHits: 2,
} as const;
export type PriceState =
  | "Strong Up"
  | "Up"
  | "Neutral"
  | "Down"
  | "Strong Down"
  | "Unknown";
export type BreadthMomentum =
  | "Strong Improving"
  | "Improving"
  | "Neutral"
  | "Deteriorating"
  | "Strong Deteriorating"
  | "Unknown";
export type VolatilityState =
  | "Rising"
  | "Mildly Rising"
  | "Stable"
  | "Mildly Falling"
  | "Falling"
  | "Unknown";
export type MarketState =
  | "Broad Risk-On"
  | "Risk-On Expansion"
  | "Risk-On Recovery"
  | "Risk-On"
  | "Narrow Rally"
  | "Rotation"
  | "Transition"
  | "Risk-Off"
  | "Neutral"
  | "Unknown";
export const STATE_LABELS: Record<MarketState, string> = {
  "Broad Risk-On": "广泛风险偏好",
  "Risk-On Expansion": "风险偏好扩张",
  "Risk-On Recovery": "风险偏好修复",
  "Risk-On": "风险偏好改善",
  "Narrow Rally": "窄幅上涨",
  Rotation: "持续风格分化",
  Transition: "持续结构冲突",
  "Risk-Off": "风险偏好收缩",
  Neutral: "方向尚未形成共识",
  Unknown: "等待完整数据",
};
export type MarketStructure = {
  leadership:
    | "Broad"
    | "Growth-led"
    | "Small-cap-led"
    | "Defensive-led"
    | "Narrow"
    | "Mixed"
    | "Unknown";
  smallCap: "Leading" | "Confirming" | "Lagging" | "Unknown";
  sectorBreadth: "Expanding" | "Stable" | "Contracting" | "Unknown";
  growthSpread: number | null;
  smallCapSpread: number | null;
  sectorUp: number | null;
  sectorPrevious: number | null;
  sector5dUp: number | null;
  sectorTotal: number;
};
export type MarketFrame = {
  date: string;
  metrics: Metric[];
  breadth: number | null;
  priorBreadth: number | null;
  sectorUp: number | null;
  sectorPrevious: number | null;
  sector5dUp: number | null;
  defensiveSpread: number | null;
};
export type MarketEngine = {
  version: typeof ENGINE_VERSION;
  state: MarketState;
  label: string;
  price: PriceState;
  prices: { symbol: string; state: PriceState; change: number | null }[];
  temperature: {
    value: number | null;
    delta: number | null;
    level: "Broad" | "Balanced" | "Weak" | "Unknown";
    momentum: BreadthMomentum;
  };
  volatility: {
    state: VolatilityState;
    value: number | null;
    change: number | null;
    level: "Low" | "Normal" | "Elevated" | "High" | "Unknown";
  };
  structure: MarketStructure;
  evidence: string[];
  missing: string[];
  persistence: {
    dates: string[];
    conflicts: number;
    rotations: number;
    required: number;
  };
  rules: typeof MARKET_RULES;
  basis?: "daily" | "reconstructed";
  inputs: MarketFrame[];
  coverage?: { valid: number; total: number; membershipAsOf: string | null };
};
const rounded = (v: number | null) => (v == null ? null : Number(v.toFixed(8)));
const known = (v: number | null | undefined): v is number =>
  v != null && Number.isFinite(v);
export function priceState(v: number | null): PriceState {
  v = rounded(v);
  if (!known(v)) return "Unknown";
  if (v >= MARKET_RULES.strongPrice) return "Strong Up";
  if (v > MARKET_RULES.priceNoise) return "Up";
  if (v <= -MARKET_RULES.strongPrice) return "Strong Down";
  if (v < -MARKET_RULES.priceNoise) return "Down";
  return "Neutral";
}
export function breadthMomentum(v: number | null): BreadthMomentum {
  v = rounded(v);
  if (!known(v)) return "Unknown";
  return v > 15
    ? "Strong Improving"
    : v > 5
      ? "Improving"
      : v < -15
        ? "Strong Deteriorating"
        : v < -5
          ? "Deteriorating"
          : "Neutral";
}
export function volatilityState(v: number | null): VolatilityState {
  v = rounded(v);
  if (!known(v)) return "Unknown";
  return v > 5
    ? "Rising"
    : v > 2
      ? "Mildly Rising"
      : v < -5
        ? "Falling"
        : v < -2
          ? "Mildly Falling"
          : "Stable";
}
function dimensions(f: MarketFrame) {
  const change = (s: string) =>
    rounded(f.metrics.find((m) => m.symbol === s)?.change ?? null);
  const spy = change("SPY"),
    qqq = change("QQQ"),
    iwm = change("IWM"),
    vix = change("VIX");
  // SPX 与 SPY 高度重叠，显示二者但用三个股票 ETF 表决，避免大盘重复投票。
  const values = [spy, qqq, iwm];
  const up = values.filter(
    (v) => known(v) && v > MARKET_RULES.priceNoise,
  ).length;
  const down = values.filter(
    (v) => known(v) && v < -MARKET_RULES.priceNoise,
  ).length;
  const price: PriceState = values.some((v) => !known(v))
    ? "Unknown"
    : values.every((v) => v! >= 1)
      ? "Strong Up"
      : values.every((v) => v! <= -1)
        ? "Strong Down"
        : up >= 2
          ? "Up"
          : down >= 2
            ? "Down"
            : "Neutral";
  const delta =
    known(f.breadth) && known(f.priorBreadth)
      ? rounded(f.breadth - f.priorBreadth)
      : null;
  const growthSpread = known(qqq) && known(spy) ? rounded(qqq - spy) : null;
  const smallCapSpread = known(iwm) && known(spy) ? rounded(iwm - spy) : null;
  const sectorDelta =
    known(f.sectorUp) && known(f.sectorPrevious)
      ? f.sectorUp - f.sectorPrevious
      : null;
  const structure: MarketStructure = {
    leadership: "Mixed",
    smallCap: !known(smallCapSpread)
      ? "Unknown"
      : smallCapSpread > 0.3
        ? "Leading"
        : smallCapSpread < -0.3
          ? "Lagging"
          : "Confirming",
    sectorBreadth: !known(sectorDelta)
      ? "Unknown"
      : sectorDelta >= 2
        ? "Expanding"
        : sectorDelta <= -2
          ? "Contracting"
          : "Stable",
    growthSpread,
    smallCapSpread,
    sectorUp: f.sectorUp,
    sectorPrevious: f.sectorPrevious,
    sector5dUp: f.sector5dUp,
    sectorTotal: 11,
  };
  if (price === "Unknown" || !known(f.breadth))
    structure.leadership = "Unknown";
  else if (known(f.defensiveSpread) && f.defensiveSpread > 0.3 && down >= 2)
    structure.leadership = "Defensive-led";
  else if (
    known(growthSpread) &&
    growthSpread > 0.3 &&
    growthSpread >= (smallCapSpread ?? -Infinity)
  )
    structure.leadership = "Growth-led";
  else if (structure.smallCap === "Leading")
    structure.leadership = "Small-cap-led";
  else if (up === 3 && f.breadth! >= 60 && (f.sectorUp ?? 0) >= 7)
    structure.leadership = "Broad";
  else if (known(spy) && spy > 0.2 && f.breadth! < 50)
    structure.leadership = "Narrow";
  const conflict =
    known(delta) &&
    delta < -5 &&
    known(vix) &&
    vix > 2 &&
    known(iwm) &&
    iwm < -0.2 &&
    known(spy) &&
    spy > 0.2;
  const flatConflict =
    price === "Neutral" &&
    known(delta) &&
    delta < -15 &&
    known(vix) &&
    vix > 5 &&
    structure.sectorBreadth === "Contracting";
  return {
    price,
    delta,
    vix,
    up,
    down,
    structure,
    conflict: conflict || flatConflict,
    rotation:
      up > 0 &&
      down > 0 &&
      known(f.breadth) &&
      known(vix) &&
      !conflict &&
      !flatConflict,
  };
}
/** frames 必须为当日、前一、前二交易日，绝不传入之后的数据。 */
export function marketEngine(frames: MarketFrame[]): MarketEngine {
  if (!frames.length) throw new Error("Market engine requires a dated frame");
  const f = frames[0],
    d = dimensions(f);
  const recent = frames.slice(0, 3).map(dimensions);
  const conflicts = recent.filter((x) => x.conflict).length;
  const rotations = recent.filter((x) => x.rotation).length;
  const vixValue = f.metrics.find((m) => m.symbol === "VIX")?.today ?? null;
  const missing = f.metrics
    .filter((m) => !known(m.change))
    .map((m) => `${m.symbol} 当日/前日收盘`);
  if (!known(f.breadth)) missing.push("有效广度样本");
  if (!known(f.priorBreadth)) missing.push("前日广度（无法判断修复速度）");
  if (!known(f.sectorUp)) missing.push("11 板块日收益");
  let state: MarketState = "Neutral";
  const rising = d.up >= 2,
    falling = d.down >= 2,
    calm = known(d.vix) && d.vix <= 2;
  // 优先级固定：缺失→收缩→持续冲突→窄涨→扩张→广泛→修复→改善→轮动→中性。
  const coreReady =
    d.price !== "Unknown" &&
    known(d.vix) &&
    known(f.breadth) &&
    known(f.metrics.find((m) => m.symbol === "SPX")?.change);
  if (!coreReady) state = "Unknown";
  else if (falling && f.breadth! <= 40 && d.vix! > 2) state = "Risk-Off";
  else if (d.conflict && conflicts >= 2) state = "Transition";
  else if (rising && f.breadth! < 50) state = "Narrow Rally";
  else if (
    rising &&
    calm &&
    f.breadth! >= 50 &&
    (d.delta ?? 0) > 15 &&
    d.structure.sectorBreadth === "Expanding" &&
    d.structure.smallCap !== "Lagging"
  )
    state = "Risk-On Expansion";
  else if (
    d.up === 3 &&
    calm &&
    f.breadth! >= 60 &&
    (f.sectorUp ?? 0) >= 7 &&
    d.structure.smallCap !== "Lagging"
  )
    state = "Broad Risk-On";
  else if (rising && calm && (d.delta ?? 0) > 5 && f.breadth! >= 40)
    state = "Risk-On Recovery";
  else if (rising && calm && f.breadth! >= 50) state = "Risk-On";
  else if (d.rotation && rotations >= 2) state = "Rotation";
  const evidence = [
    `SPY / QQQ / IWM：${d.up} 个明显上涨、${d.down} 个明显下跌（噪音带 ±0.2%）。`,
    known(f.breadth)
      ? `上涨比例 ${f.breadth.toFixed(1)}%${known(d.delta) ? `，较前日 ${d.delta > 0 ? "+" : ""}${d.delta.toFixed(1)} pp` : "，前日比例缺失"}。`
      : "上涨比例缺失，无法确认参与度。",
    known(d.vix)
      ? `VIX ${d.vix > 0 ? "+" : ""}${d.vix.toFixed(2)}%，${volatilityState(d.vix)}。`
      : "VIX 数据缺失。",
  ];
  if (d.conflict)
    evidence.push(
      `显著结构冲突在最近 ${recent.length} 日出现 ${conflicts} 次${conflicts < 2 ? "，尚未满足持续性条件" : ""}。`,
    );
  if (d.rotation)
    evidence.push(
      `显著风格分化在最近 ${recent.length} 日出现 ${rotations} 次。`,
    );
  return {
    version: ENGINE_VERSION,
    state,
    label: STATE_LABELS[state],
    price: d.price,
    prices: f.metrics
      .filter((m) => m.symbol !== "VIX")
      .map((m) => ({
        symbol: m.symbol,
        state: priceState(m.change),
        change: m.change,
      })),
    temperature: {
      value: f.breadth,
      delta: d.delta,
      level: !known(f.breadth)
        ? "Unknown"
        : f.breadth >= 60
          ? "Broad"
          : f.breadth <= 40
            ? "Weak"
            : "Balanced",
      momentum: breadthMomentum(d.delta),
    },
    volatility: {
      state: volatilityState(d.vix),
      value: vixValue,
      change: d.vix,
      level: !known(vixValue)
        ? "Unknown"
        : vixValue < 15
          ? "Low"
          : vixValue < 25
            ? "Normal"
            : vixValue < 35
              ? "Elevated"
              : "High",
    },
    structure: d.structure,
    evidence,
    missing,
    persistence: {
      dates: frames.slice(0, 3).map((x) => x.date),
      conflicts,
      rotations,
      required: 2,
    },
    rules: MARKET_RULES,
    inputs: frames.slice(0, 3),
  };
}
export function legacyRegime(state: MarketState): Regime {
  switch (state) {
    case "Broad Risk-On":
    case "Risk-On Expansion":
    case "Risk-On Recovery":
    case "Risk-On":
    case "Narrow Rally":
      return "Risk-On";
    default:
      return state;
  }
}
export function engineSummary(e: MarketEngine): string {
  if (e.state === "Unknown")
    return "指数、波动率或广度资料不足，暂不判定市场状态。";
  const leader = {
    Broad: "广泛参与",
    "Growth-led": "成长领先",
    "Small-cap-led": "小盘领先",
    "Defensive-led": "防御领先",
    Narrow: "参与集中",
    Mixed: "风格分化",
    Unknown: "结构数据不足",
  }[e.structure.leadership];
  const small = {
    Leading: "领先",
    Confirming: "同步",
    Lagging: "落后",
    Unknown: "数据不足",
  }[e.structure.smallCap];
  const vol = {
    Rising: "上升",
    "Mildly Rising": "温和上升",
    Stable: "稳定",
    "Mildly Falling": "温和下降",
    Falling: "下降",
    Unknown: "数据不足",
  }[e.volatility.state];
  return `${e.label}。${e.evidence[1]} ${leader}，小盘${small}，波动率${vol}。`;
}
