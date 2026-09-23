import {
  existsSync,
  readFileSync,
  readdirSync,
  mkdirSync,
  copyFileSync,
} from "node:fs";
import path from "node:path";
import { writeJsonAtomic } from "@/lib/files/atomicJson";
import type { GexSnapshot, OptionsMeta } from "@/lib/options/structure";
import type { DailyReview, OptionsRow } from "./types";
import { enrichOptionsRow } from "./options";

function matchingMeta(
  snapshot: GexSnapshot | null,
  item: OptionsRow["today"],
): OptionsMeta | undefined {
  if (!item) return undefined;
  const candidate = snapshot?.items.find((r) => r.symbol === item.symbol);
  if (
    !candidate ||
    !["as_of", "spot", "net_gex", "gamma_flip", "put_wall", "call_wall"].every(
      (key) =>
        candidate[key as keyof typeof candidate] ===
        item[key as keyof typeof item],
    )
  )
    return undefined;
  return {
    source: snapshot?.source,
    method: snapshot?.method,
    method_version: snapshot?.method_version,
    fetched_at: snapshot?.fetched_at,
  };
}

/** Only derived options fields change. No market, signal, account or publication timestamps are rewritten. */
export function backfillOptionsStructures(root: string, write = false) {
  const dir = path.join(root, "snapshots/daily-review");
  const backup = path.join(
    root,
    "backups",
    `options-structure-${new Date().toISOString().replaceAll(":", "-")}`,
  );
  const readGex = (date: string | null): GexSnapshot | null => {
    if (!date) return null;
    const file = path.join(root, "snapshots/gex-history", `${date}.json`);
    return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
  };
  const changed: string[] = [];
  for (const name of readdirSync(dir)
    .filter((n) => /^\d{4}-\d{2}-\d{2}\.json$/.test(n))
    .sort()) {
    const file = path.join(dir, name);
    const review = JSON.parse(readFileSync(file, "utf8")) as DailyReview;
    if (
      review.version !== 1 ||
      review.date !== name.slice(0, 10) ||
      !Array.isArray(review.options)
    )
      throw new Error(`Invalid review: ${name}`);
    const current = readGex(review.date),
      previous = readGex(review.previousDate);
    const options = review.options.map((row) =>
      row.structure
        ? row
        : enrichOptionsRow(
            {
              ...row,
              meta: row.meta ?? matchingMeta(current, row.today),
              previousMeta:
                row.previousMeta ?? matchingMeta(previous, row.previous),
            },
            "reconstructed",
          ),
    );
    if (JSON.stringify(options) === JSON.stringify(review.options)) continue;
    changed.push(review.date);
    if (write) {
      mkdirSync(backup, { recursive: true });
      copyFileSync(file, path.join(backup, name));
      writeJsonAtomic(file, { ...review, options });
    }
  }
  return { write, changed, backup: write && changed.length ? backup : null };
}
