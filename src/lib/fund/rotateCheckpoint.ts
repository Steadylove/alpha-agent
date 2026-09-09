import type { RotateCheckpoint } from "./rotate";

/** 恢复状态损坏时停止，不退回从 1 开始的计算。 */
export function rotateCheckpointOf(raw: unknown): RotateCheckpoint {
  const c = raw as RotateCheckpoint;
  const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
  const record = (v: unknown): boolean => typeof v === "object" && v != null && !Array.isArray(v);
  const fail = () => { throw new Error("连续账本恢复状态无效，原成绩未覆盖"); };
  if (!c || c.version !== 1 || typeof c.asOf !== "string" || !c.asOf || !finite(c.cash) || c.cash < -1e-8 ||
    !finite(c.lastEq) || c.lastEq <= 0 || !finite(c.seed) || !record(c.slots) || !record(c.legs) ||
    !record(c.decisions) || !record(c.totals) || !Array.isArray(c.orders) || !Array.isArray(c.dailyEquity)) fail();
  for (const k of ["entries", "rotations", "missed", "holdingSum", "exposureSum", "exits", "wins", "bars"] as const) {
    if (!finite(c.totals[k]) || c.totals[k] < 0) fail();
  }
  for (const [symbol, slot] of Object.entries(c.slots)) {
    if (!slot || !c.legs[symbol] || !finite(slot.shares) || slot.shares <= 0 || !finite(slot.cost) || slot.cost <= 0 ||
      !finite(slot.eqAtEntry) || !finite(slot.entryPrice) || slot.entryPrice <= 0 || typeof slot.entryDate !== "string" ||
      ![1, 2].includes(slot.sigType) || !finite(slot.entryRps)) fail();
  }
  for (const [symbol, leg] of Object.entries(c.legs)) {
    const s = leg?.state;
    if (!leg || !finite(leg.lastClose) || !finite(leg.lastRps) || !s || ![0, 1, 2].includes(s.sigType) ||
      ![0, 1, 2].includes(s.pendingEntry) || ![null, "stop", "target", "veto", "rsWeak", "rotate"].includes(s.pendingExit)) fail();
    for (const k of ["highWater", "maxPnlPct", "initialRisk", "pendingEntryAtr", "pendingEntryRps"] as const) if (!finite(s[k])) fail();
    if (s.sigType && (!c.slots[symbol] || !finite(s.entryPrice) || !finite(s.stopLevel) || !finite(s.trailLevel) || typeof s.entryDate !== "string")) fail();
    if (c.slots[symbol] && (!s.sigType || c.slots[symbol].entryDate !== s.entryDate || c.slots[symbol].entryPrice !== s.entryPrice)) fail();
  }
  for (const o of c.orders) if (!o || typeof o.symbol !== "string" || !c.legs[o.symbol] || !finite(o.amount) || o.amount <= 0) fail();
  for (const p of c.dailyEquity) if (!p || typeof p.date !== "string" || !finite(p.v) || p.v <= 0) fail();
  const equity = c.cash + Object.entries(c.slots).reduce((sum, [symbol, slot]) => sum + slot.shares * c.legs[symbol].lastClose, 0);
  if (Math.abs(equity - c.lastEq) > 1e-8 * Math.max(1, c.lastEq) || c.totals.wins > c.totals.exits) fail();
  return c;
}
