import { enrichOptionsRow } from "./options";
import {
  marketEngine,
  legacyRegime,
  engineSummary,
  type MarketFrame,
} from "./engine";
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

/** 板块 11 ETF 与细分行业 3 ETF 分组排名；组内缺项不缩小分母。 */
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
    rs.map((r, i) => {
      const peers = rs.filter(
        (_, j) => REVIEW_SECTORS[j].group === REVIEW_SECTORS[i].group,
      );
      if (r == null || peers.some((v) => v == null)) return null;
      return (
        (100 *
          (peers.filter((v) => v! < r).length +
            (peers.filter((v) => v === r).length - 1) / 2)) /
        (peers.length - 1)
      );
    });
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
  sectors = sectors.filter((s) => s.group === "sector");
  previousSectors = previousSectors.filter((s) => s.group === "sector");
  const strong = (rows: SectorStrength[]) =>
    metric20("SPY") != null &&
    rows.length === 11 &&
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
    spy20 != null &&
    previousSectors.length === 11 &&
    previousSectors.every((s) => s.return20 != null)
      ? previousSectors.filter((s) => s.return20! > 0 && s.return20! > spy20)
          .length
      : null;
  const countUp = (offset: number, period = 1) => {
    const xs = REVIEW_SECTORS.filter((s) => s.group === "sector").map((s) => {
      const a = closeOn(bars, s.symbol, sessions[at - offset]);
      const b = closeOn(bars, s.symbol, sessions[at - offset - period]);
      return a != null && b != null ? pct(a, b) : null;
    });
    return xs.every(finite) ? xs.filter((x) => x! > 0.2).length : null;
  };
  const frames: MarketFrame[] = [0, 1, 2]
    .filter((o) => at - o >= 0)
    .map((o) => {
      const day = sessions[at - o],
        prior = sessions[at - o - 1];
      const ms = REVIEW_INDICES.map((s) => metric(bars, s, day, prior ?? null));
      const defensive = ["XLP", "XLU", "XLV"].map(
        (s) => metric(bars, s, day, prior ?? null).change,
      );
      const spy = ms.find((m) => m.symbol === "SPY")!.change;
      return {
        date: day,
        metrics: ms,
        breadth: breadthAt(day, prior).value,
        priorBreadth: breadthAt(prior, sessions[at - o - 2]).value,
        sectorUp: countUp(o),
        sectorPrevious: countUp(o + 1),
        sector5dUp: countUp(o, 5),
        defensiveSpread:
          defensive.every(finite) && spy != null
            ? defensive.reduce((a, b) => a + b!, 0)! / 3 - spy
            : null,
      };
    });
  const engine = marketEngine(frames);
  engine.coverage = {
    valid: today.valid,
    total: members.length,
    membershipAsOf,
  };
  const regime = legacyRegime(engine.state),
    summary = engineSummary(engine);
  return {
    regime,
    summary,
    engine,
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
      total: 11,
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
    const valid = row ?? null;
    const past = previous?.find((r) => r.symbol === symbol);
    const comparable = !!(
      valid &&
      past?.today &&
      quoteDay(past.today.as_of) === previousDate &&
      current?.dte &&
      current.dte === past.dte
    );
    return enrichOptionsRow({
      symbol,
      today: valid,
      previous: comparable ? past!.today : null,
      dte: current?.dte ?? null,
      comparable,
      meta: current
        ? {
            source: current.source,
            method: current.method,
            method_version: current.method_version,
            fetched_at: current.fetched_at,
          }
        : undefined,
      previousMeta: past?.meta,
      changes: [],
    });
  });
}
