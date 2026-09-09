import { fetchLatestShortInterest } from "@/lib/data-sources/finra";
import { fetchSecSharesOutstanding, fetchSecTickerCikMap } from "@/lib/data-sources/sec";
import { ROTATION_UNIVERSE } from "@/lib/scoring/rotationUniverse";
import { readSnapshot, writeSnapshot } from "@/lib/vps/snapshot";

/**
 * 刷新空头持仓缓存，写入 VPS snapshots/short-interest.json。
 */

export type ShortInterestRow = {
  symbol: string;
  settlementDate: string;
  sharesShort: number;
  sharesOutstanding: number | null;
};

export type ShortInterestSnapshot = {
  settlementDate: string;
  rows: ShortInterestRow[];
};

export type ShortInterestJobResult = {
  settlementDate: string | null;
  symbolsWritten: number;
  shortInterestMissing: string[];
  sharesMissing: string[];
  skippedAsFresh: boolean;
};

export async function runShortInterestJob(): Promise<ShortInterestJobResult> {
  const symbols = ROTATION_UNIVERSE.map((t) => t.symbol);
  const latest = await fetchLatestShortInterest(symbols);
  if (latest.size === 0) {
    throw new Error("FINRA 窗口内无任何记录，检查回看天数或接口可用性");
  }

  const settlementDate = [...latest.values()]
    .map((r) => r.settlementDate)
    .reduce((a, b) => (b > a ? b : a));

  const existing = (await readSnapshot<ShortInterestSnapshot>("short-interest")) ?? {
    settlementDate: "",
    rows: [],
  };

  if (existing.settlementDate === settlementDate && existing.rows.length === latest.size) {
    return {
      settlementDate,
      symbolsWritten: 0,
      shortInterestMissing: [],
      sharesMissing: [],
      skippedAsFresh: true,
    };
  }

  const knownShares = new Map<string, number>();
  for (const e of existing.rows) {
    if (e.sharesOutstanding != null) knownShares.set(e.symbol, e.sharesOutstanding);
  }

  const needShares = symbols.filter((s) => latest.has(s) && !knownShares.has(s));
  if (needShares.length > 0) {
    const ciks = await fetchSecTickerCikMap();
    for (const symbol of needShares) {
      const cik = ciks.get(symbol);
      if (!cik) continue;
      const shares = await fetchSecSharesOutstanding(cik);
      if (shares != null && shares > 0) knownShares.set(symbol, shares);
    }
  }

  const shortInterestMissing: string[] = [];
  const sharesMissing: string[] = [];
  const rows: ShortInterestRow[] = [];

  for (const symbol of symbols) {
    const record = latest.get(symbol);
    if (!record) {
      shortInterestMissing.push(symbol);
      continue;
    }
    const sharesOutstanding = knownShares.get(symbol) ?? null;
    if (sharesOutstanding == null) sharesMissing.push(symbol);
    rows.push({
      symbol,
      settlementDate: record.settlementDate,
      sharesShort: record.sharesShort,
      sharesOutstanding,
    });
  }

  writeSnapshot("short-interest", { settlementDate, rows });

  return {
    settlementDate,
    symbolsWritten: rows.length,
    shortInterestMissing,
    sharesMissing,
    skippedAsFresh: false,
  };
}
