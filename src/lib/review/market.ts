import { SECTOR_UNIVERSE } from "@/lib/scoring/sectorUniverse";
import type { DailyBarRow } from "@/lib/vps/loadDailyBars";
import type { GexSnapshot } from "@/lib/discord/gexCopy";
import type { Metric, OptionsRow, ReviewMarket, SectorStrength } from "./types";

export const REVIEW_SECTORS = [
  ...SECTOR_UNIVERSE.map((s) => ({
    symbol: s.symbol,
    name: s.name,
    group: "sector" as const,
  })),
  { symbol: "SMH", name: "半导体", group: "industry" as const },
  { symbol: "IGV", name: "软件", group: "industry" as const },
  { symbol: "KBE", name: "银行", group: "industry" as const },
];
export const REVIEW_INDICES = ["SPX", "QQQ", "SPY", "IWM", "VIX"];
export type Bars = Map<string, DailyBarRow[]>;
/** RPS 日历只覆盖近期：较早日期用 SPY 已有交易日；覆盖区内尊重交易所日历的缺口。 */
export function reviewSessions(
  spyDates: string[],
  calendar?: { from: string; through: string; sessions: string[] },
): string[] {
  if (!calendar?.sessions?.length) return [...new Set(spyDates)].sort();
  return [
    ...new Set([
      ...spyDates.filter((d) => d < calendar.from || d > calendar.through),
      ...calendar.sessions,
    ]),
  ].sort();
}
export const finite = (x: unknown): x is number =>
  typeof x === "number" && Number.isFinite(x);
export const positive = (x: unknown): x is number => finite(x) && x > 0;
export const pct = (a: number, b: number) => (a / b - 1) * 100;
export const closeOn = (
  bars: Bars,
  symbol: string,
  date?: string | null,
): number | null => {
  const value = date
    ? bars.get(symbol)?.find((b) => b.date === date)?.close
    : null;
  return positive(value) ? value : null;
};
export function metric(
  bars: Bars,
  symbol: string,
  date: string,
  previous: string | null,
): Metric {
  const today = closeOn(bars, symbol, date),
    yesterday = closeOn(bars, symbol, previous);
  return {
    symbol,
    today,
    yesterday,
    change: today != null && yesterday != null ? pct(today, yesterday) : null,
  };
}

/** 固定 14 ETF 截面、20 个交易日收益排名；缺任何一只就不缩小样本重排。 */
export function sectorStrength(
  bars: Bars,
  sessions: string[],
  date: string,
): SectorStrength[] {
  const at = sessions.indexOf(date);
  const returnsAt = (offset: number) =>
    REVIEW_SECTORS.map((s) => {
      const end = at - offset,
        a = closeOn(bars, s.symbol, sessions[end]),
        b = closeOn(bars, s.symbol, sessions[end - 20]);
      return a != null && b != null ? pct(a, b) : null;
    });
  const ranks = (rs: (number | null)[]) =>
    rs.some((r) => r == null)
      ? rs.map(() => null)
      : rs.map(
          (r) =>
            (100 *
              (rs.filter((v) => v! < r!).length +
                (rs.filter((v) => v === r).length - 1) / 2)) /
            (rs.length - 1),
        );
  const returns = returnsAt(0),
    now = ranks(returns),
    p1 = ranks(returnsAt(1)),
    p5 = ranks(returnsAt(5)),
    p20 = ranks(returnsAt(20));
  const delta = (a: number | null, b: number | null) =>
    a != null && b != null ? a - b : null;
  return REVIEW_SECTORS.map((s, i) => ({
    ...s,
    rps: now[i],
    d1: delta(now[i], p1[i]),
    d5: delta(now[i], p5[i]),
    d20: delta(now[i], p20[i]),
    return20: returns[i],
    change: metric(bars, s.symbol, date, sessions[at - 1]).change,
  }));
}

export function marketReview(
  bars: Bars,
  sessions: string[],
  date: string,
  members: string[],
  membershipAsOf: string | null,
  sectors: SectorStrength[],
  previousSectors: SectorStrength[],
): ReviewMarket {
  const at = sessions.indexOf(date),
    previous = sessions[at - 1] ?? null;
  const metrics = REVIEW_INDICES.map((s) => metric(bars, s, date, previous));
  const breadthAt = (day: string | undefined, prior: string | undefined) => {
    const xs =
      day && prior
        ? members.map((s) => metric(bars, s, day, prior).change).filter(finite)
        : [];
    return {
      value:
        members.length >= 100 && xs.length / members.length >= 0.95
          ? (xs.filter((x) => x > 0).length / xs.length) * 100
          : null,
      valid: xs.length,
    };
  };
  const today = breadthAt(date, previous ?? undefined),
    yesterday = breadthAt(previous ?? undefined, sessions[at - 2]);
  const strong = (rows: SectorStrength[]) =>
    metric20("SPY") != null &&
    rows.length > 0 &&
    rows.every((s) => s.return20 != null)
      ? rows.filter((s) => s.return20! > 0 && s.return20! > metric20("SPY")!)
          .length
      : null;
  function metric20(symbol: string, offset = 0) {
    const a = closeOn(bars, symbol, sessions[at - offset]),
      b = closeOn(bars, symbol, sessions[at - offset - 20]);
    return a != null && b != null ? pct(a, b) : null;
  }
  const spy20 = metric20("SPY", 1);
  const strongYesterday =
    spy20 != null && previousSectors.every((s) => s.return20 != null)
      ? previousSectors.filter((s) => s.return20! > 0 && s.return20! > spy20)
          .length
      : null;
  const stocks = metrics.filter((x) =>
    ["SPY", "QQQ", "IWM"].includes(x.symbol),
  );
  const vix = metrics.find((x) => x.symbol === "VIX")!.change;
  let regime: ReviewMarket["regime"] = "Unknown",
    summary = "指数、波动率或广度数据不足，暂不判定市场状态。";
  if (
    stocks.every((s) => s.change != null) &&
    vix != null &&
    today.value != null
  ) {
    const up = stocks.filter((s) => s.change! > 0).length;
    if (up === 3 && today.value >= 60 && vix <= 0) {
      regime = "Risk-On";
      summary =
        "主要股票 ETF 同涨，超过六成样本上涨，VIX 未上升。风险偏好扩散。";
    } else if (
      up === 0 &&
      stocks.every((s) => s.change! < 0) &&
      today.value <= 40 &&
      vix >= 0
    ) {
      regime = "Risk-Off";
      summary =
        "主要股票 ETF 同跌，上涨样本不足四成，VIX 未下降。风险偏好收缩。";
    } else if (up > 0 && up < 3) {
      regime = "Rotation";
      summary = "大盘、科技与小盘表现分化，资金正在不同风格间轮动。";
    } else {
      regime = "Transition";
      summary = "指数、市场广度与波动率未形成一致方向，市场处于过渡状态。";
    }
  }
  return {
    regime,
    summary,
    metrics,
    breadth: {
      today: today.value,
      yesterday: yesterday.value,
      valid: today.valid,
      total: members.length,
      universe: "标普成分股样本",
      membershipAsOf,
    },
    strongSectors: {
      today: strong(sectors),
      yesterday: strongYesterday,
      total: REVIEW_SECTORS.length,
    },
  };
}

/** Cboe 无时区时间戳按其美东报价日期；带时区的时间戳转换到美东。 */
export function quoteDay(stamp?: string): string | null {
  if (!stamp || !/^\d{4}-\d{2}-\d{2}T/.test(stamp)) return null;
  if (!/(Z|[+-]\d{2}:?\d{2})$/.test(stamp)) return stamp.slice(0, 10);
  const d = new Date(stamp);
  return Number.isFinite(d.getTime())
    ? new Intl.DateTimeFormat("en-CA", {
        timeZone: "America/New_York",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(d)
    : null;
}

export function optionsMap(
  current: GexSnapshot | null,
  previous: OptionsRow[] | undefined,
  date: string,
  previousDate: string | null,
): OptionsRow[] {
  return ["SPX", "SPY", "QQQ", "IWM"].map((symbol) => {
    const row = current?.items?.find(
      (i) => i.symbol === symbol && quoteDay(i.as_of) === date,
    );
    const valid = row && positive(row.spot) && finite(row.net_gex) ? row : null;
    const past = previous?.find((r) => r.symbol === symbol);
    const comparable = !!(
      valid &&
      past?.today &&
      quoteDay(past.today.as_of) === previousDate &&
      current?.dte &&
      current.dte === past.dte
    );
    const changes: string[] = [];
    if (comparable) {
      for (const [key, label] of [
        ["gamma_flip", "Flip"],
        ["put_wall", "Put Wall"],
        ["call_wall", "Call Wall"],
      ] as const) {
        const a = past!.today![key],
          b = valid![key];
        if (finite(a) && finite(b) && a !== b)
          changes.push(`${label} ${a.toFixed(2)} → ${b.toFixed(2)}`);
      }
      const a = past!.today!.net_gex,
        b = valid!.net_gex;
      if (a * b < 0) changes.push(`Net GEX ${a > 0 ? "由正转负" : "由负转正"}`);
      if (!changes.length) changes.push("关键价位未变；Net GEX 数值变化见表");
    }
    return {
      symbol,
      today: valid,
      previous: comparable ? past!.today : null,
      dte: current?.dte ?? null,
      comparable,
      changes,
    };
  });
}
