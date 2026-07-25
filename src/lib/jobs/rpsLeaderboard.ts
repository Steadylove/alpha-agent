import { fetchSp500Universe } from "@/lib/data-sources/sp500";
import { fetchManyDailyBars } from "@/lib/data-sources/marketData";
import { getPrisma } from "@/lib/db/prisma";
import { stockUniverse as fallbackUniverse } from "@/lib/fixtures/universe";
import { percentChange, percentileRank } from "@/lib/scoring/indicators";
import { BASE_RPS_THRESHOLD } from "@/lib/scoring/rpsPlaybooks";
import type { DailyBar, Instrument } from "@/lib/types/market";

export const RPS_WINDOWS = [20, 50, 120, 250] as const;
export type RpsWindow = (typeof RPS_WINDOWS)[number];

/** Discord / 前端展示条数 */
export const LEADERBOARD_TOP_N = 100;
/** @deprecated 使用 BASE_RPS_THRESHOLD；保持导出以免旧引用断裂 */
export const ELITE_RPS_THRESHOLD = BASE_RPS_THRESHOLD;
/** 落库日线根数（覆盖 RPS250 + 一点缓冲） */
const PERSIST_BAR_LIMIT = 400;

export type LeaderboardRow = {
  rank: number;
  symbol: string;
  name: string;
  sector: string | null;
  rps: number;
  ret: number; // decimal, e.g. 0.21
};

export type EliteRow = {
  symbol: string;
  name: string;
  sector: string | null;
  rps20: number;
  rps50: number;
  rps120: number;
  rps250: number;
};

export type RpsLeaderboardResult = {
  generatedAt: Date;
  universeSize: number;
  rankedSize: number;
  dailyFetchErrors: number;
  barsPersisted: number;
  boards: Record<RpsWindow, LeaderboardRow[]>;
  /** 四周期 RPS 均 > ELITE_RPS_THRESHOLD */
  elite: EliteRow[];
};

function returnOverWindow(bars: DailyBar[], window: number): number | null {
  return percentChange(
    bars.map((b) => b.close),
    window,
  );
}

function toDate(value: string) {
  return new Date(`${value}T00:00:00.000Z`);
}

async function upsertInstruments(instruments: Instrument[]) {
  const prisma = getPrisma();
  for (const instrument of instruments) {
    await prisma.instrument.upsert({
      where: { symbol: instrument.symbol },
      update: {
        name: instrument.name,
        type: instrument.type,
        sector: instrument.sector,
        industry: instrument.industry,
        exchange: instrument.exchange,
        isActive: true,
      },
      create: {
        symbol: instrument.symbol,
        name: instrument.name,
        type: instrument.type,
        sector: instrument.sector,
        industry: instrument.industry,
        exchange: instrument.exchange,
      },
    });
  }
}

async function persistBars(barsBySymbol: Map<string, DailyBar[]>): Promise<number> {
  const prisma = getPrisma();
  let written = 0;
  const symbols = [...barsBySymbol.keys()];
  const concurrency = 8;
  let cursor = 0;

  const workers = Array.from({ length: concurrency }, async () => {
    while (cursor < symbols.length) {
      const idx = cursor;
      cursor += 1;
      const symbol = symbols[idx];
      const bars = barsBySymbol.get(symbol) ?? [];
      if (bars.length === 0) continue;

      const instrument = await prisma.instrument.findUnique({ where: { symbol } });
      if (!instrument) continue;

      const slice = bars.slice(-PERSIST_BAR_LIMIT);
      // 批量插入（已存在则跳过）；历史 K 线基本不变
      const payload = slice.map((bar) => ({
        instrumentId: instrument.id,
        date: toDate(bar.date),
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
        volume: BigInt(Math.trunc(bar.volume)),
        source: bar.source,
      }));

      for (let i = 0; i < payload.length; i += 100) {
        const chunk = payload.slice(i, i + 100);
        const result = await prisma.dailyBar.createMany({
          data: chunk,
          skipDuplicates: true,
        });
        written += result.count;
      }

      // 最近 5 根强制 upsert，保证当日/近端价更新
      for (const bar of slice.slice(-5)) {
        await prisma.dailyBar.upsert({
          where: {
            instrumentId_date: {
              instrumentId: instrument.id,
              date: toDate(bar.date),
            },
          },
          update: {
            open: bar.open,
            high: bar.high,
            low: bar.low,
            close: bar.close,
            volume: BigInt(Math.trunc(bar.volume)),
            source: bar.source,
          },
          create: {
            instrumentId: instrument.id,
            date: toDate(bar.date),
            open: bar.open,
            high: bar.high,
            low: bar.low,
            close: bar.close,
            volume: BigInt(Math.trunc(bar.volume)),
            source: bar.source,
          },
        });
      }
    }
  });

  await Promise.all(workers);
  return written;
}

export async function runRpsLeaderboardJob(): Promise<RpsLeaderboardResult> {
  const generatedAt = new Date();
  const sp500 = await fetchSp500Universe();
  const universe: Instrument[] = sp500.length > 0 ? sp500 : fallbackUniverse;
  const symbols = universe.map((u) => u.symbol);
  const instrumentBySymbol = new Map(universe.map((u) => [u.symbol, u]));

  await upsertInstruments(universe);

  const { barsBySymbol, errors } = await fetchManyDailyBars(symbols, {
    concurrency: 10,
  });

  const barsPersisted = await persistBars(barsBySymbol);

  const candidates = symbols
    .map((s) => ({ symbol: s, bars: barsBySymbol.get(s) ?? [] }))
    .filter((c) => c.bars.length >= 250);

  const boards = {} as Record<RpsWindow, LeaderboardRow[]>;

  for (const w of RPS_WINDOWS) {
    const returns = candidates.map((c) => returnOverWindow(c.bars, w) ?? 0);
    const rows: LeaderboardRow[] = candidates.map((c, i) => {
      const inst = instrumentBySymbol.get(c.symbol);
      return {
        rank: 0,
        symbol: c.symbol,
        name: inst?.name ?? c.symbol,
        sector: inst?.sector ?? null,
        rps: percentileRank(returns[i], returns),
        ret: returns[i],
      };
    });
    rows.sort((a, b) => b.rps - a.rps || b.ret - a.ret);
    rows.forEach((row, idx) => {
      row.rank = idx + 1;
    });
    boards[w] = rows;
  }

  const rpsBySymbol = new Map<string, Record<RpsWindow, number>>();
  for (const w of RPS_WINDOWS) {
    for (const row of boards[w]) {
      const cur = rpsBySymbol.get(row.symbol) ?? { 20: 0, 50: 0, 120: 0, 250: 0 };
      cur[w] = row.rps;
      rpsBySymbol.set(row.symbol, cur);
    }
  }

  const elite: EliteRow[] = [...rpsBySymbol.entries()]
    .filter(([, rps]) => RPS_WINDOWS.every((w) => rps[w] > ELITE_RPS_THRESHOLD))
    .map(([symbol, rps]) => {
      const inst = instrumentBySymbol.get(symbol);
      return {
        symbol,
        name: inst?.name ?? symbol,
        sector: inst?.sector ?? null,
        rps20: rps[20],
        rps50: rps[50],
        rps120: rps[120],
        rps250: rps[250],
      };
    })
    .sort((a, b) => {
      const minA = Math.min(a.rps20, a.rps50, a.rps120, a.rps250);
      const minB = Math.min(b.rps20, b.rps50, b.rps120, b.rps250);
      return minB - minA || b.rps20 - a.rps20;
    });

  return {
    generatedAt,
    universeSize: universe.length,
    rankedSize: candidates.length,
    dailyFetchErrors: Object.keys(errors).length,
    barsPersisted,
    boards,
    elite,
  };
}
