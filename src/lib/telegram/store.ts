import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { writeJsonAtomic } from "@/lib/files/atomicJson";

export type Topic = { threadId?: number; title: string };
export type Group = {
  id: string; title: string; present: boolean; writable: boolean; paused: boolean;
  updatedAt: number; nextSendAt: number; migratedTo?: string; migratedFrom?: string;
  messageThreadId?: number; needsTopic?: boolean;
  topics?: Record<string, Topic>;
};
export type Delivery = {
  chatId: string; state: "pending" | "sent" | "failed" | "skipped";
  attempts: number; nextAt: number; messageId?: number; error?: number;
  messageThreadId?: number;
};
export type TelegramJob = {
  id: string; createdAt: number; content: string; png?: string; fileId?: string;
  direct?: boolean; deliveries: Delivery[];
};
type State = { version: 1; offset: number; groups: Record<string, Group>; nextApiAt?: number };
export const subscribed = (g: Group) => g.present && g.writable && !g.paused && !g.migratedTo && !g.needsTopic && topicsOf(g).length > 0;

export function topicKey(threadId?: number): string {
  return threadId === undefined ? "g" : String(threadId);
}

export function parseTarget(id: string): { chatId: string; topicKey: string } {
  const at = id.lastIndexOf("#");
  if (at <= 0) return { chatId: id, topicKey: "*" };
  return { chatId: id.slice(0, at), topicKey: id.slice(at + 1) };
}

export function topicsOf(g: Group): Array<{ key: string; threadId?: number; title: string }> {
  if (g.topics && Object.keys(g.topics).length) {
    return Object.entries(g.topics).map(([key, topic]) => ({ key, threadId: topic.threadId, title: topic.title }));
  }
  if (g.needsTopic) return [];
  const key = topicKey(g.messageThreadId);
  return [{ key, threadId: g.messageThreadId, title: g.messageThreadId != null ? `话题 #${g.messageThreadId}` : "General" }];
}

export function topicLive(g: Group, threadId?: number): boolean {
  return topicsOf(g).some((topic) => topic.threadId === threadId);
}

export function bindTopic(g: Group | undefined, threadId: number | undefined, title: string): Record<string, Topic> {
  const topics = g?.topics && Object.keys(g.topics).length
    ? { ...g.topics }
    : g && !g.needsTopic
      ? { [topicKey(g.messageThreadId)]: { threadId: g.messageThreadId, title: g.messageThreadId != null ? `话题 #${g.messageThreadId}` : "General" } }
      : {};
  topics[topicKey(threadId)] = { threadId, title };
  return topics;
}

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
  targets() {
    return Object.values(this.state.groups).flatMap((g) => {
      if (!g.present || g.migratedTo) return [];
      const topics = topicsOf(g);
      if (!topics.length) return [{ id: g.id, title: g.title, subscribed: false, messageThreadId: g.messageThreadId }];
      return topics.map((topic) => ({
        id: `${g.id}#${topic.key}`,
        title: topics.length === 1 && topic.threadId === undefined ? g.title : `${g.title} · ${topic.title}`,
        subscribed: subscribed(g),
        messageThreadId: topic.threadId,
      }));
    });
  }
  enqueue(id: string, content: string, png?: string, directChat?: string, now = Date.now(), directThreadId?: number, chatIds?: readonly string[]) {
    const prior = this.jobs.get(id);
    if (prior?.deliveries.length) return { duplicate: true, recipients: prior.deliveries.length };
    const deliveries: Delivery[] = [];
    const seen = new Set<string>();
    const add = (chatId: string, messageThreadId?: number) => {
      const key = `${chatId}#${topicKey(messageThreadId)}`;
      if (seen.has(key)) return;
      seen.add(key);
      deliveries.push({ chatId, state: "pending", attempts: 0, nextAt: now, messageThreadId });
    };
    if (directChat) add(directChat, directThreadId);
    else if (chatIds) {
      for (const target of chatIds) {
        const parsed = parseTarget(target);
        const group = this.state.groups[parsed.chatId];
        if (!group || !subscribed(group)) continue;
        const topics = topicsOf(group);
        for (const topic of parsed.topicKey === "*" ? topics : topics.filter((item) => item.key === parsed.topicKey)) {
          add(group.id, topic.threadId);
        }
      }
    } else {
      for (const group of Object.values(this.state.groups).filter(subscribed)) {
        for (const topic of topicsOf(group)) add(group.id, topic.threadId);
      }
    }
    this.saveJob({ id, content, png, createdAt: now, direct: !!directChat, deliveries });
    return { duplicate: false, recipients: deliveries.length };
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
