import { mkdirSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import type { AgentSettings, AgentThread, AgentThreadSummary } from "../../src/lib/siteAgent/types";

export const settingsSchema = z.object({ dailyTurnLimit: z.number().int().min(0).max(500),
  dailyTokenBudget: z.number().int().min(0).max(5_000_000), maxTaskMinutes: z.number().int().min(1).max(120) }).strict();
/** Daily request and token budgets are retained as legacy state fields but disabled. */
export const DEFAULT_SETTINGS: AgentSettings = { dailyTurnLimit: 0, dailyTokenBudget: 0, maxTaskMinutes: 15 };
export function withoutDailyLimits(settings: AgentSettings): AgentSettings {
  return { ...settings, dailyTurnLimit: 0, dailyTokenBudget: 0 };
}
export type StoredThread = AgentThread & { nativeId: string | null; activeTurnId: string | null; nativeInputTokens: number; nativeOutputTokens: number };
export type DayUsage = { turns: number; inputTokens: number; outputTokens: number };
const HISTORY_NOTE = "较早的展示内容已截断；完整原始历史保留在服务器的 Codex 私有会话中。";
function boundedText(text: string, bytes: number) {
  if (Buffer.byteLength(text) <= bytes) return text;
  return Buffer.from(text).subarray(0, bytes - 120).toString("utf8").replace(/\uFFFD$/, "") + "\n[展示内容已截断，原始历史保留在 Codex 私有会话中。]";
}
export class AgentStore {
  readonly threads = new Map<string, StoredThread>();
  settings: AgentSettings = { ...DEFAULT_SETTINGS };
  readonly days: Record<string, DayUsage> = {};
  constructor(private directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const file = path.join(directory, "state.json");
    if (!existsSync(file)) return;
    const raw = JSON.parse(readFileSync(file, "utf8"));
    if (raw.version !== 1 || !Array.isArray(raw.threads) || raw.threads.length > 500) throw new Error("Agent 会话存储格式无效");
    this.settings = withoutDailyLimits(settingsSchema.parse(raw.settings));
    Object.assign(this.days, raw.days ?? {});
    for (const thread of raw.threads as StoredThread[]) {
      if (!/^[a-f0-9-]{36}$/.test(thread.id) || !Array.isArray(thread.messages) || !Array.isArray(thread.activities)) throw new Error("Agent 会话存储校验失败");
      if (thread.status === "running" || thread.status === "waiting") {
        thread.status = "interrupted"; thread.error = "服务重启，中断的任务未自动重试；你可以继续此会话。";
      }
      thread.activeTurnId = null; thread.approvals = []; this.threads.set(thread.id, thread);
    }
    this.save();
  }
  day() { return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date()); }
  usage(date = this.day()) { return this.days[date] ??= { turns: 0, inputTokens: 0, outputTokens: 0 }; }
  save() {
    const target = path.join(this.directory, "state.json"), temp = `${target}.${randomUUID()}.tmp`;
    // Keep one year of usage; full Codex history remains in its private home.
    const dates = Object.keys(this.days).sort(); for (const date of dates.slice(0, Math.max(0, dates.length - 366))) delete this.days[date];
    for (const thread of this.threads.values()) this.boundThread(thread);
    writeFileSync(temp, JSON.stringify({ version: 1, settings: this.settings, days: this.days, threads: [...this.threads.values()] }), { mode: 0o600 });
    renameSync(temp, target);
  }
  get(id: string) { const thread = this.threads.get(id); if (!thread) throw new Error("会话不存在"); return thread; }
  boundThread(thread: StoredThread) {
    let truncated = thread.messages.some(message => message.id === "history-truncated");
    const messages = thread.messages.filter(message => message.id !== "history-truncated");
    for (const message of messages) message.text = boundedText(message.text, 64_000);
    let bytes = 0, first = messages.length;
    while (first > 0 && messages.length - first < 200) {
      const size = Buffer.byteLength(JSON.stringify(messages[first - 1]));
      if (bytes + size > 600_000) break;
      bytes += size; first--;
    }
    truncated ||= first > 0;
    thread.messages = messages.slice(first);
    if (truncated) thread.messages.unshift({ id: "history-truncated", role: "assistant", text: HISTORY_NOTE, createdAt: thread.createdAt });
    thread.activities = thread.activities.slice(-50);
    for (const activity of thread.activities) {
      activity.title = boundedText(activity.title, 600);
      if (activity.detail) activity.detail = boundedText(activity.detail, 5000);
    }
    while (Buffer.byteLength(JSON.stringify(thread.activities)) > 300_000) thread.activities.shift();
  }
  publicThread(thread: StoredThread): AgentThread {
    this.boundThread(thread);
    const { nativeId: _native, activeTurnId: _turn, nativeInputTokens: _input, nativeOutputTokens: _output, ...view } = thread;
    return structuredClone(view);
  }
  summaries(): AgentThreadSummary[] {
    return [...this.threads.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(t => ({ id: t.id,
      title: t.title, createdAt: t.createdAt, updatedAt: t.updatedAt, status: t.status, model: t.model, effort: t.effort,
      mode: t.mode, archived: t.archived, inputTokens: t.inputTokens, outputTokens: t.outputTokens }));
  }
}
