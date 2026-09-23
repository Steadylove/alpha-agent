import { readSnapshot, writeSnapshot } from "@/lib/vps/snapshot";
import {
  makeOptionsPublication,
  freezeOptionsContext,
  missingOptionsContext,
  type OptionsPublication,
} from "@/lib/options/signalContext";
import type { OptionsRow } from "./types";

/** Same-day retries publish a new availability time; they never modify frozen signal contexts. */
export function publishOptionsContext(
  date: string,
  rows: OptionsRow[],
  sessions: string[],
  publishedAt = new Date().toISOString(),
) {
  if (
    sessions.some(
      (d, i) =>
        !/^\d{4}-\d{2}-\d{2}$/.test(d) || (i > 0 && d <= sessions[i - 1]),
    )
  )
    return null;
  const index = sessions.indexOf(date);
  const next = index >= 0 ? sessions[index + 1] : undefined;
  if (!next) return null;
  const publication = makeOptionsPublication(date, rows, publishedAt, next);
  if (publication) writeSnapshot("daily-review/options-context", publication);
  return publication;
}

export async function optionsContextBefore(
  signalTime: number,
  frozenAt: string,
  expectedDate?: string,
) {
  try {
    // A separate file keeps macro supplements from changing option availability timestamps.
    const publication = await readSnapshot<OptionsPublication>(
      "daily-review/options-context",
      AbortSignal.timeout(1200),
    );
    return freezeOptionsContext(
      publication,
      signalTime,
      frozenAt,
      expectedDate,
    );
  } catch {
    return missingOptionsContext(signalTime, frozenAt, "unavailable");
  }
}
