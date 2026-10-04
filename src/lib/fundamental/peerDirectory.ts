import { existsSync, readFileSync, statSync } from "node:fs";
import { z } from "zod";
import { snapshotFile } from "@/lib/vps/snapshot";
import { symbolSchema } from "./types";

const DAY = 86400000;

/** A local symbol/industry directory is only a peer-search seed, never an RPS/score input. */
export function readFundamentalPeerDirectory(now: Date): { symbol: string; industry: string; sector?: string }[] {
  try {
    const file = snapshotFile("screener");
    if (!existsSync(file) || statSync(file).size > 8 * 1024 * 1024) return [];
    const parsed = z.object({ generatedAt: z.iso.datetime({ offset: true }), ranked: z.array(z.unknown()).max(1000) })
      .safeParse(JSON.parse(readFileSync(file, "utf8")));
    if (!parsed.success) return [];
    const generated = Date.parse(parsed.data.generatedAt);
    if (generated > now.getTime() || now.getTime() - generated > 90 * DAY) return [];
    const rowSchema = z.object({ symbol: symbolSchema, industry: z.string().trim().min(1).max(200),
      sector: z.string().trim().min(1).max(200).optional().catch(undefined) });
    const directory = parsed.data.ranked.flatMap(raw => {
      const row = rowSchema.safeParse(raw);
      return row.success ? [row.data] : [];
    }).sort((a, b) => a.symbol.localeCompare(b.symbol) || a.industry.localeCompare(b.industry));
    // Alphabetical deduplication deliberately discards screener ranking and all price/strength fields.
    return directory.filter((row, index) => index === 0 || row.symbol !== directory[index - 1].symbol);
  } catch { return []; }
}
