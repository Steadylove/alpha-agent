import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { writeJsonAtomic } from "@/lib/files/atomicJson";

export type Group = {
  id: string; title: string; present: boolean; writable: boolean; paused: boolean;
  updatedAt: number; nextSendAt: number; migratedTo?: string; migratedFrom?: string;
};
export type Delivery = {
  chatId: string; state: "pending" | "sent" | "failed" | "skipped";
  attempts: number; nextAt: number; messageId?: number; error?: number;
};
export type TelegramJob = {
  id: string; createdAt: number; content: string; png?: string; fileId?: string;
  direct?: boolean; deliveries: Delivery[];
};
type State = { version: 1; offset: number; groups: Record<string, Group>; nextApiAt?: number };
export const subscribed = (g: Group) => g.present && g.writable && !g.paused && !g.migratedTo;

/** 由唯一常驻 worker 写入；所有内存变更与落盘均同步完成，避免并发读改写丢失。 */
export class TelegramStore {
  state: State;
  jobs = new Map<string, TelegramJob>();
  constructor(private dir: string) {
    mkdirSync(path.join(dir, "jobs"), { recursive: true });
    const stateFile = path.join(dir, "state.json");
    this.state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : { version: 1, offset: 0, groups: {} };
    if (this.state.version !== 1 || !this.state.groups || !Number.isSafeInteger(this.state.offset)) throw new Error("Invalid Telegram store");
    for (const file of readdirSync(path.join(dir, "jobs"))) {
      if (!/^[a-f0-9]{64}\.json$/.test(file)) continue;
      const job: TelegramJob = JSON.parse(readFileSync(path.join(dir, "jobs", file), "utf8"));
      if (job.id !== file.slice(0, -5) || !Array.isArray(job.deliveries)) throw new Error("Invalid Telegram job");
      this.jobs.set(job.id, job);
    }
  }
  saveState() { writeJsonAtomic(path.join(this.dir, "state.json"), this.state); }
  saveJob(job: TelegramJob) {
    if (!/^[a-f0-9]{64}$/.test(job.id)) throw new Error("Invalid job id");
    // 已完成的任务仅保留发送凭据和去重 ID，不永久存储图片。
    if (!job.deliveries.some((d) => d.state === "pending")) delete job.png;
    writeJsonAtomic(path.join(this.dir, "jobs", `${job.id}.json`), job);
    this.jobs.set(job.id, job);
  }
  enqueue(id: string, content: string, png?: string, directChat?: string, now = Date.now()) {
    const prior = this.jobs.get(id);
    if (prior) return { duplicate: true, recipients: prior.deliveries.length };
    const chats = directChat ? [directChat] : Object.values(this.state.groups).filter(subscribed).map((g) => g.id);
    this.saveJob({ id, content, png, createdAt: now, direct: !!directChat,
      deliveries: chats.map((chatId) => ({ chatId, state: "pending", attempts: 0, nextAt: now })) });
    return { duplicate: false, recipients: chats.length };
  }
  cancelGroup(chatId: string) {
    for (const job of this.jobs.values()) {
      if (job.direct) continue;
      let changed = false;
      for (const d of job.deliveries) if (d.chatId === chatId && d.state === "pending") { d.state = "skipped"; changed = true; }
      if (changed) this.saveJob(job);
    }
  }
  migrate(from: string, to: string) {
    const old = this.state.groups[from];
    if (!old || from === to) return;
    this.state.groups[to] = { ...old, ...this.state.groups[to], id: to, paused: old.paused, migratedTo: undefined, migratedFrom: from };
    this.state.groups[from] = { ...old, present: false, migratedTo: to };
    this.saveState();
    for (const job of this.jobs.values()) {
      let changed = false;
      for (const d of job.deliveries) if (d.chatId === from && d.state === "pending") {
        if (job.deliveries.some((other) => other !== d && other.chatId === to)) d.state = "skipped";
        else d.chatId = to;
        changed = true;
      }
      if (changed) this.saveJob(job);
    }
  }
  stats() {
    const counts = { subscribed: Object.values(this.state.groups).filter(subscribed).length, pending: 0, sent: 0, failed: 0, skipped: 0 };
    for (const job of this.jobs.values()) for (const d of job.deliveries) counts[d.state]++;
    return counts;
  }
}
