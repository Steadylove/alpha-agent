import { readFileSync, statSync } from "node:fs";
import { z } from "zod";
import { writeJsonAtomic } from "@/lib/files/atomicJson";
import { snapshotFile } from "@/lib/vps/snapshot";
import { symbolSchema } from "./types";

const LIMIT = 1000, MAX_BYTES = 2 * 1024 * 1024, MAX_AGE = 90 * 86400000;
const rowSchema = z.object({ symbol: symbolSchema, cik: z.string().regex(/^\d{10}$/).refine(value => Number(value) > 0),
  sic: z.number().int().min(1).max(9999), observedAt: z.iso.datetime({ offset: true }), sourceUrl: z.string().max(120) })
  .refine(row => row.sourceUrl === `https://data.sec.gov/submissions/CIK${row.cik}.json`);
export type SecIssuerDirectoryEntry = z.infer<typeof rowSchema>;
const snapshotSchema = z.object({ version: z.literal(1), generatedAt: z.iso.datetime({ offset: true }), records: z.array(z.unknown()).max(LIMIT) });
const fresh = (stamp: number, now: Date) => Number.isFinite(now.getTime()) && stamp <= now.getTime() && now.getTime() - stamp <= MAX_AGE;

function select(records: readonly unknown[], now: Date): SecIssuerDirectoryEntry[] {
  const bySymbol = new Map<string, { stamp: number; entry: SecIssuerDirectoryEntry | null }>();
  for (const raw of records) {
    const parsed = rowSchema.safeParse(raw);
    if (!parsed.success) continue;
    const row = parsed.data, stamp = Date.parse(row.observedAt);
    if (!fresh(stamp, now)) continue;
    const prior = bySymbol.get(row.symbol);
    if (!prior || stamp > prior.stamp) bySymbol.set(row.symbol, { stamp, entry: { ...row, observedAt: new Date(stamp).toISOString() } });
    else if (stamp === prior.stamp && prior.entry && (row.cik !== prior.entry.cik || row.sic !== prior.entry.sic)) prior.entry = null;
  }
  return [...bySymbol.values()].flatMap(value => value.entry ? [value.entry] : []).sort((a, b) => a.symbol.localeCompare(b.symbol));
}

/** Candidate discovery only. Call once when constructing a provider so a round never depends on target execution order. */
export function readSecIssuerDirectory(now: Date): SecIssuerDirectoryEntry[] {
  try {
    const file = snapshotFile("fundamental-sec-issuers");
    if (statSync(file).size > MAX_BYTES) return [];
    const text = readFileSync(file, "utf8");
    if (Buffer.byteLength(text, "utf8") > MAX_BYTES) return [];
    const parsed = snapshotSchema.safeParse(JSON.parse(text));
    if (!parsed.success || !fresh(Date.parse(parsed.data.generatedAt), now)) return [];
    return select(parsed.data.records, now);
  } catch { return []; }
}

/** Explicit job write, never part of diagnostic collection. New observations become candidates in the next provider instance. */
export function writeSecIssuerDirectory(records: readonly SecIssuerDirectoryEntry[], now: Date): SecIssuerDirectoryEntry[] {
  if (!Number.isFinite(now.getTime()) || records.length > LIMIT) throw new Error("SEC issuer directory input exceeds its budget or has an invalid time");
  const merged = select([...readSecIssuerDirectory(now), ...records], now);
  const snapshot = { version: 1, generatedAt: now.toISOString(), records: merged };
  if (merged.length > LIMIT || Buffer.byteLength(JSON.stringify(snapshot), "utf8") + 1 > MAX_BYTES) throw new Error("SEC issuer directory exceeds its snapshot budget");
  writeJsonAtomic(snapshotFile("fundamental-sec-issuers"), snapshot);
  return merged;
}
