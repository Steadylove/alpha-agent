import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { appConfig } from "../../../app.config";
import { digest, intradaySignalSchema, sessionDate, signalId, tradeId, type IntradaySignal } from "./protocol";

export type SignalDelivery = { target: string; channel: "discord" | "telegram"; state: "pending" | "queued" | "sent" | "failed" | "skipped"; attempts: number; nextAt: number; jobId?: string; messageId?: string; error?: string };
export type IntradayRecord = {
  version: 1; id: string; tradeId: string | null; date: string; receivedAt: number;
  payload: IntradaySignal; disposition: "accepted" | "stale" | "future";
  state: "pending" | "tracking" | "done" | "skipped"; reason?: string;
  routeUpdatedAt?: string; deliveries?: SignalDelivery[];
  entrySeenAtReceipt: boolean | null;
};

/** One VPS process owns the store. fsync before acknowledgement; no Vercel temporary filesystem. */
export class IntradayStore {
  pending = new Map<string, IntradayRecord>();
  constructor(readonly dir: string) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    for (const date of readdirSync(dir).filter(validDate)) {
      for (const row of this.list(date)) if (row.state === "pending" || row.state === "tracking") this.pending.set(row.id, row);
    }
  }
  private file(date: string, id: string) {
    if (!validDate(date) || !/^[a-f0-9]{64}$/.test(id)) throw new Error("Invalid archive key");
    return path.join(this.dir, date, `${id}.json`);
  }
  save(row: IntradayRecord) {
    const file = this.file(row.date, row.id), parent = path.dirname(file);
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    const temp = `${file}.${randomUUID()}.tmp`;
    try {
      const fd = openSync(temp, "wx", 0o600);
      try { writeFileSync(fd, `${JSON.stringify(row)}\n`); fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(temp, file);
      const fdDir = openSync(parent, "r"); try { fsyncSync(fdDir); } finally { closeSync(fdDir); }
    } finally { rmSync(temp, { force: true }); }
    if (row.state === "pending" || row.state === "tracking") this.pending.set(row.id, row);
    else this.pending.delete(row.id);
  }
  get(date: string, id: string): IntradayRecord | null {
    const file = this.file(date, id);
    return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) as IntradayRecord : null;
  }
  list(date: string): IntradayRecord[] {
    if (!validDate(date)) throw new Error("Invalid date");
    const dir = path.join(this.dir, date);
    if (!existsSync(dir)) return [];
    return readdirSync(dir).filter(f => /^[a-f0-9]{64}\.json$/.test(f)).map(f => this.get(date, f.slice(0, -5))!)
      .sort((a, b) => a.payload.signalTime - b.payload.signalTime || a.id.localeCompare(b.id));
  }
  hasEntry(p: IntradaySignal): boolean | null {
    if (p.entrySignalTime === null) return null;
    const id = signalId({ ...p, event: "entry", barTime: p.entrySignalTime - 60_000 });
    const entry = this.get(sessionDate(p.entrySignalTime - 1), id);
    return entry?.payload.event === "entry" && entry.tradeId === tradeId(p);
  }
  private receipt(date: string, data: unknown) {
    const dir = path.join(this.dir, date); mkdirSync(dir, { recursive: true, mode: 0o700 });
    const fd = openSync(path.join(dir, "receipts.ndjson"), "a", 0o600);
    try { writeFileSync(fd, `${JSON.stringify(data)}\n`); fsyncSync(fd); } finally { closeSync(fd); }
  }
  accept(raw: unknown, now = Date.now()) {
    const p = intradaySignalSchema.parse(raw), id = signalId(p), date = sessionDate(p.barTime);
    const existing = this.get(date, id);
    if (existing) {
      const conflict = digest(existing.payload) !== digest(p);
      this.receipt(date, { receivedAt: now, id, status: conflict ? "conflict" : "duplicate", payload: p });
      return { ok: true, recorded: true, id, duplicate: true, conflict, disposition: existing.disposition };
    }
    const age = now - p.signalTime;
    const disposition = age > appConfig.intraday.maxSignalAgeMs ? "stale" : age < -appConfig.intraday.maxFutureSkewMs ? "future" : "accepted";
    const row: IntradayRecord = { version: 1, id, date, tradeId: tradeId(p), receivedAt: now, payload: p, disposition,
      entrySeenAtReceipt: p.event === "entry" ? true : this.hasEntry(p),
      state: disposition === "accepted" ? "pending" : "skipped", ...(disposition === "accepted" ? {} : { reason: disposition }) };
    this.save(row);
    this.receipt(date, { receivedAt: now, id, status: disposition, payload: p });
    return { ok: true, recorded: true, id, duplicate: false, conflict: false, disposition };
  }
}
export function validDate(date: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(Date.parse(`${date}T00:00:00Z`)) && new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) === date;
}
