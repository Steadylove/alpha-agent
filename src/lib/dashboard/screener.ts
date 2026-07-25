import type { ScreenerResult, ScreenerRow } from "@/lib/jobs/alphaScreener";
import { BASE_RPS_THRESHOLD } from "@/lib/scoring/rpsPlaybooks";

export type ScreenerPageData = ScreenerResult & {
  date: string;
};

type StoredBuckets = {
  baseThreshold?: number;
  elite?: ScreenerRow[];
};

function parseBuckets(raw: unknown): {
  baseThreshold: number;
  elite: ScreenerRow[];
} {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { baseThreshold: BASE_RPS_THRESHOLD, elite: [] };
  }
  const stored = raw as StoredBuckets;
  const elite = (Array.isArray(stored.elite) ? stored.elite : []).map((row) => ({
    ...row,
    industryLabel:
      row.industryLabel ??
      [row.sector, row.industry].filter(Boolean).join("｜") ??
      "行业未知",
    blurb: row.blurb ?? row.name,
  }));
  return {
    baseThreshold: stored.baseThreshold ?? BASE_RPS_THRESHOLD,
    elite,
  };
}

export async function getLatestScreenerData(): Promise<ScreenerPageData | null> {
  if (!process.env.DATABASE_URL) return null;

  const { getPrisma } = await import("@/lib/db/prisma");
  const prisma = getPrisma();
  const row = await prisma.alphaScreenerRun.findFirst({
    orderBy: { date: "desc" },
  });
  if (!row) return null;

  const parsed = parseBuckets(row.buckets);

  return {
    date: row.date.toISOString().slice(0, 10),
    generatedAt: row.createdAt,
    universeSize: row.universeSize,
    rankedSize: row.universeSize,
    baseThreshold: parsed.baseThreshold,
    elite: parsed.elite,
    dailyFetchErrors: row.dailyFetchErrors,
  };
}
