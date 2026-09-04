/**
 * 信号台人工确认/否决账本。存在 `.cache`，不进 git。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export type DeskDecisionKind = "confirm" | "reject";

export type DeskDecision = {
  id: string;
  date: string;
  timeframe: string;
  poolId: string;
  symbol: string;
  sigType: 1 | 2;
  rps: number;
  rawWeightPct: number;
  decision: DeskDecisionKind;
  note: string;
  at: string;
};

export function deskDecisionId(input: {
  date: string;
  timeframe: string;
  poolId: string;
  symbol: string;
  sigType: 1 | 2;
}): string {
  return `${input.date}|${input.timeframe}|${input.poolId}|${input.symbol}|${input.sigType}`;
}

export function ledgerPath(): string {
  if (process.env.DESK_LEDGER_PATH) return process.env.DESK_LEDGER_PATH;
  return path.join(/*turbopackIgnore: true*/ process.cwd(), ".cache", "desk-ledger.json");
}

export function readLedger(): DeskDecision[] {
  const file = ledgerPath();
  if (!existsSync(file)) return [];
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as unknown;
    return Array.isArray(raw) ? (raw as DeskDecision[]) : [];
  } catch {
    return [];
  }
}

export function upsertDecision(
  input: Omit<DeskDecision, "id" | "at"> & { at?: string },
): DeskDecision {
  const row: DeskDecision = {
    ...input,
    id: deskDecisionId(input),
    note: input.note ?? "",
    at: input.at ?? new Date().toISOString(),
  };
  const all = readLedger().filter((d) => d.id !== row.id);
  all.push(row);
  all.sort((a, b) => (a.at < b.at ? 1 : -1));
  const file = ledgerPath();
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(all, null, 2)}\n`);
  return row;
}

export function decisionMap(rows: readonly DeskDecision[]): Map<string, DeskDecision> {
  return new Map(rows.map((d) => [d.id, d]));
}
