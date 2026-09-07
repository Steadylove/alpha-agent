import { clampLookbackSlots, DEFAULT_LOOKBACK_SLOTS, isLookbackTf, type LookbackTf } from "./lookbackLogic";
import { tickerListOf } from "./signalPoolLogic";

export type LookbackSnapshot = {
  id: string;
  name: string;
  savedAt: string;
  members: string[];
  tf: LookbackTf;
  from: string;
  slots: number;
  asOf: string;
  pnl: string;
  equity: number;
  cagr: number;
  dd: number;
  mar: number;
  ytdPct: number | null;
};

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MAX_SNAPS = 40;
const MAX_NAME = 40;

export function defaultSnapshotName(input: {
  from: string;
  members: readonly string[];
  tf: LookbackTf;
  pnl: string;
}): string {
  return `${input.from} · ${input.members.length}只 · ${input.tf} · ${input.pnl}`;
}

function trimName(raw: unknown, fallback: string): string {
  if (typeof raw !== "string") return fallback;
  const name = raw.trim().slice(0, MAX_NAME);
  return name || fallback;
}

export function snapshotOf(raw: unknown): LookbackSnapshot | null {
  if (typeof raw !== "object" || raw === null) return null;
  const p = raw as Partial<LookbackSnapshot>;
  const members = tickerListOf(p.members);
  const slots = clampLookbackSlots(p.slots) ?? DEFAULT_LOOKBACK_SLOTS;
  if (!members?.length || !isLookbackTf(p.tf) || typeof p.from !== "string" || !DAY.test(p.from)) {
    return null;
  }
  const pnl = typeof p.pnl === "string" && p.pnl ? p.pnl : "—";
  const name = trimName(p.name, defaultSnapshotName({ from: p.from, members, tf: p.tf, pnl }));
  return {
    id: typeof p.id === "string" && p.id ? p.id : `${p.from}-${members.length}`,
    name,
    savedAt: typeof p.savedAt === "string" ? p.savedAt : "",
    members,
    tf: p.tf,
    from: p.from,
    slots,
    asOf: typeof p.asOf === "string" ? p.asOf : "",
    pnl,
    equity: typeof p.equity === "number" && Number.isFinite(p.equity) ? p.equity : 1,
    cagr: typeof p.cagr === "number" && Number.isFinite(p.cagr) ? p.cagr : 0,
    dd: typeof p.dd === "number" && Number.isFinite(p.dd) ? p.dd : 0,
    mar: typeof p.mar === "number" && Number.isFinite(p.mar) ? p.mar : 0,
    ytdPct: typeof p.ytdPct === "number" && Number.isFinite(p.ytdPct) ? p.ytdPct : null,
  };
}

export function snapshotListOf(raw: unknown): LookbackSnapshot[] {
  if (!Array.isArray(raw)) return [];
  const out: LookbackSnapshot[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const snap = snapshotOf(item);
    if (!snap || seen.has(snap.id)) continue;
    seen.add(snap.id);
    out.push(snap);
  }
  return out;
}

export function addSnapshot(
  list: readonly LookbackSnapshot[],
  raw: unknown,
  now = new Date(),
): LookbackSnapshot[] {
  const snap = snapshotOf({
    ...(typeof raw === "object" && raw !== null ? raw : {}),
    id: now.getTime().toString(36),
    savedAt: now.toISOString(),
  });
  if (!snap) throw new Error("名单、起点和回看成绩不完整");
  return [snap, ...list.filter((s) => s.id !== snap.id)].slice(0, MAX_SNAPS);
}

export function removeSnapshot(list: readonly LookbackSnapshot[], id: string): LookbackSnapshot[] {
  return list.filter((s) => s.id !== id);
}
