import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { snapshotDir, readSnapshot } from "@/lib/vps/snapshot";
import { marketBaseUrl } from "@/lib/backtest/marketStore";
import { fetchMarketText } from "@/lib/backtest/marketRemote";
import { writeJsonAtomic } from "@/lib/files/atomicJson";
import { lastSettledNyDate } from "@/lib/backtest/mergeBars";
import type { DailyReview, ReviewIndex } from "@/lib/review/types";
import type { CatalystReport } from "./types";
import { validDay } from "./normalize";
import { buildCatalystReviewDigest, parseCatalystReviewDigest, type CatalystReviewDigest, type CatalystReviewView } from "./reviewDigest";

type Publication = { status: "saved" | "existing" | "waiting" | "unavailable"; date: string };
const json = (file: string): unknown => JSON.parse(readFileSync(file, "utf8"));
function currentSettledDate(report: CatalystReport): boolean {
  const cutoff = lastSettledNyDate(new Date(Date.parse(report.generatedAt) - 20 * 60_000));
  const days = report.sessions;
  return days.length > 0 && days.every((day, i) => validDay(day) && (!i || day > days[i - 1])) &&
    days.at(-1)! > cutoff && days.filter(day => day <= cutoff).at(-1) === report.asOf;
}
function sameContent(previous: CatalystReviewDigest, next: CatalystReviewDigest): boolean {
  const content = (digest: CatalystReviewDigest) => ({ status: digest.status, today: digest.today, upcoming: digest.upcoming,
    warnings: digest.warnings, sourceCoverage: digest.sourceCoverage ?? next.sourceCoverage });
  return JSON.stringify(content(previous)) === JSON.stringify(content(next));
}
function losesCoverage(previous: CatalystReviewDigest, next: CatalystReviewDigest): boolean {
  if (next.status === "unavailable" || previous.status === "ready" && next.status !== "ready" ||
      (previous.today.length || previous.upcoming.length) && !next.today.length && !next.upcoming.length && next.status !== "ready") return true;
  const rank = { ok: 2, partial: 1, unavailable: 0, disabled: 0 };
  return (previous.sourceCoverage ?? []).some(source => rank[source.state] > rank[next.sourceCoverage?.find(row => row.id === source.id)?.state ?? "unavailable"]);
}
/** Preserve exact previous bytes before publishing a replacement; retries verify an existing archive. */
function archiveEdition(directory: string, date: string, previous: CatalystReviewDigest, bytes: Buffer): void {
  const hash = createHash("sha256").update(bytes).digest("hex");
  const folder = path.join(directory, "catalyst", "review", "history", date);
  const file = path.join(folder, `${previous.capturedAt.replace(/[:.]/g, "-")}-${hash.slice(0, 16)}.json`);
  mkdirSync(folder, { recursive: true });
  try { writeFileSync(file, bytes, { flag: "wx" }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST" || !readFileSync(file).equals(bytes)) throw error;
  }
}

/** Called under the collector lock. Owns only catalyst/review; never edits a review or its analysis. */
export function publishCatalystReviewDigest(report: CatalystReport, directory = snapshotDir(), options: { refresh?: boolean } = {}): Publication {
  const date = report.asOf;
  if (!validDay(date)) return { status: "waiting", date };
  try {
    const file = path.join(directory, "catalyst", "review", `${date}.json`);
    let previous: CatalystReviewDigest | null = null, original: Buffer | null = null;
    if (existsSync(file)) {
      original = readFileSync(file);
      previous = parseCatalystReviewDigest(JSON.parse(original.toString("utf8")), date, new Date(report.generatedAt));
      // An informative supplement is immutable, independent of later event edits and archive pruning.
      // Empty failed/partial attempts can recover when the same day's sources become usable.
      if (!options.refresh && (previous.status === "ready" || previous.today.length || previous.upcoming.length))
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
    if (options.refresh && !currentSettledDate(report)) return { status: "waiting", date };
    let digest = buildCatalystReviewDigest(report, review);
    if (previous && (sameContent(previous, digest) || losesCoverage(previous, digest))) return { status: "existing", date };
    if (previous && Date.parse(report.generatedAt) <= Date.parse(previous.capturedAt)) return { status: "waiting", date };
    digest = parseCatalystReviewDigest({ ...digest,
      reviewBuiltAt: previous?.reviewBuiltAt ?? digest.reviewBuiltAt,
      revision: (previous?.revision ?? (previous ? 1 : 0)) + 1,
      originalCapturedAt: previous?.originalCapturedAt ?? previous?.capturedAt ?? digest.capturedAt,
      ...(previous ? { supersedesCapturedAt: previous.capturedAt } : {}),
    }, date, new Date(report.generatedAt));
    if (previous && original) archiveEdition(directory, date, previous, original);
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
