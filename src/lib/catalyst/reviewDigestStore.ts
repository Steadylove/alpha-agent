import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { snapshotDir, readSnapshot } from "@/lib/vps/snapshot";
import { marketBaseUrl } from "@/lib/backtest/marketStore";
import { fetchMarketText } from "@/lib/backtest/marketRemote";
import { writeJsonAtomic } from "@/lib/files/atomicJson";
import type { DailyReview, ReviewIndex } from "@/lib/review/types";
import type { CatalystReport } from "./types";
import { validDay } from "./normalize";
import { buildCatalystReviewDigest, parseCatalystReviewDigest, type CatalystReviewView } from "./reviewDigest";

type Publication = { status: "saved" | "existing" | "waiting" | "unavailable"; date: string };
const json = (file: string): unknown => JSON.parse(readFileSync(file, "utf8"));

/** Called under the collector lock. Owns only catalyst/review; never edits a review or its analysis. */
export function publishCatalystReviewDigest(report: CatalystReport, directory = snapshotDir()): Publication {
  const date = report.asOf;
  if (!validDay(date)) return { status: "waiting", date };
  try {
    const file = path.join(directory, "catalyst", "review", `${date}.json`);
    if (existsSync(file)) {
      const previous = parseCatalystReviewDigest(json(file), date, new Date(report.generatedAt));
      // An informative supplement is immutable, independent of later event edits and archive pruning.
      // Empty failed/partial attempts can recover when the same day's sources become usable.
      if (previous.status === "ready" || previous.today.length || previous.upcoming.length)
        return { status: "existing", date };
    }
    const reviewFile = path.join(directory, "daily-review", `${date}.json`);
    const indexFile = path.join(directory, "daily-review", "index.json");
    if (!existsSync(reviewFile) || !existsSync(indexFile)) return { status: "waiting", date };
    const index = json(indexFile) as ReviewIndex;
    const review = json(reviewFile) as DailyReview;
    if (index?.version !== 1 || index.latest !== date || review?.version !== 1 || review.date !== date ||
      !Array.isArray(review.sectors) || !Number.isFinite(Date.parse(review.builtAt)) ||
      Date.parse(review.builtAt) > Date.parse(report.generatedAt)) return { status: "waiting", date };
    const digest = parseCatalystReviewDigest(buildCatalystReviewDigest(report, review), date, new Date(report.generatedAt));
    writeJsonAtomic(file, digest);
    return { status: "saved", date };
  } catch {
    // Invalid existing supplements are preserved for diagnosis, never silently overwritten.
    // A supplement failure must not prevent the independent event page from updating.
    return { status: "unavailable", date };
  }
}

/** A visit reads this date's saved supplement only, with no collection/model calls or local remote fallback. */
export async function getCatalystReviewDigest(date: string, now = new Date()): Promise<CatalystReviewView> {
  if (!validDay(date)) return { status: "unavailable", digest: null };
  try {
    const name = `catalyst/review/${date}`;
    const signal = AbortSignal.timeout(5000);
    let raw: unknown;
    if (marketBaseUrl()) {
      const body = await fetchMarketText(`snapshots/${name}.json`, signal);
      raw = body.trim() ? JSON.parse(body) : null;
    } else raw = await readSnapshot<unknown>(name, signal);
    if (raw == null) return { status: "missing", digest: null };
    return { status: "ready", digest: parseCatalystReviewDigest(raw, date, now) };
  } catch { return { status: "unavailable", digest: null }; }
}
