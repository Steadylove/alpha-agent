import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { writeJsonAtomic } from "@/lib/files/atomicJson";
import { deskRemoteUrl, writeDeskJson } from "@/lib/fund/deskRemote";
import { optionFlowPath } from "./store";
import { flowTimestamp } from "./provenance";
import type { DiscordMessageLike } from "./parseDiscord";

export const OPTION_FLOW_HEALTH_FILE = "option-flow-health.json";
export type FlowCollectionError = "source-forbidden" | "source-rate-limited" | "source-http-error" | "collection-failed";
export type FlowChannelHealth = {
  channelId: string; mode: "full" | "since" | "incremental";
  requestStartedAt: string; completedAt: string; state: "ok" | "unavailable";
  since: string | null; afterId: string | null; lastMessageId: string | null;
  received: number | null; oldestRelayAt: string | null; newestRelayAt: string | null;
  errorCode: FlowCollectionError | null;
};
export type FlowCollectionHealth = {
  version: 1; startedAt: string; checkedAt: string; lastSuccessfulAt: string | null;
  state: "ok" | "unavailable"; expectedChannelIds: string[]; channels: FlowChannelHealth[];
  errorCode: FlowCollectionError | null;
  scope: "discord-relay-poll";
};
export function safeFlowCollectionError(error: unknown): FlowCollectionError {
  const message = error instanceof Error ? error.message : "";
  if (/\bHTTP 403\b/.test(message)) return "source-forbidden";
  if (/\bHTTP 429\b/.test(message)) return "source-rate-limited";
  return /\bHTTP \d{3}\b/.test(message) ? "source-http-error" : "collection-failed";
}
export function flowChannelHealth(input: {
  channelId: string; mode: FlowChannelHealth["mode"]; startedAt: string; completedAt: string;
  since?: string | null; afterId?: string | null; raw?: DiscordMessageLike[]; error?: unknown; failed?: boolean;
}): FlowChannelHealth {
  const dates = (input.raw ?? []).map(message => flowTimestamp(message.timestamp)).filter((value): value is string => value !== null).sort();
  const raw = input.raw;
  return {
    channelId: input.channelId, mode: input.mode, requestStartedAt: input.startedAt, completedAt: input.completedAt,
    state: input.failed ? "unavailable" : "ok", since: flowTimestamp(input.since), afterId: input.afterId ?? null,
    lastMessageId: raw?.at(-1)?.id ?? input.afterId ?? null, received: raw ? raw.length : null,
    oldestRelayAt: dates[0] ?? null, newestRelayAt: dates.at(-1) ?? null,
    errorCode: input.failed ? safeFlowCollectionError(input.error) : null,
  };
}
export function optionFlowHealthPath(): string { return path.join(path.dirname(optionFlowPath()), OPTION_FLOW_HEALTH_FILE); }
export function completeFlowCollection(input: {
  startedAt: string; checkedAt: string; expectedChannelIds: string[]; channels: FlowChannelHealth[];
  failed?: boolean; error?: unknown; previous?: FlowCollectionHealth | null;
}): FlowCollectionHealth {
  const complete = !input.failed && input.expectedChannelIds.length > 0 && input.expectedChannelIds.every(id => input.channels.some(channel => channel.channelId === id && channel.state === "ok"));
  return {
    version: 1, scope: "discord-relay-poll", startedAt: input.startedAt, checkedAt: input.checkedAt,
    lastSuccessfulAt: complete ? input.checkedAt : flowTimestamp(input.previous?.lastSuccessfulAt),
    state: complete ? "ok" : "unavailable", expectedChannelIds: [...new Set(input.expectedChannelIds)].slice(0, 10), channels: input.channels.slice(0, 10),
    errorCode: complete ? null : safeFlowCollectionError(input.error),
  };
}
export function readLocalFlowCollectionHealth(): FlowCollectionHealth | null {
  try {
    const file = optionFlowHealthPath();
    const value = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) as Partial<FlowCollectionHealth> : null;
    return value?.version === 1 && value.scope === "discord-relay-poll" && flowTimestamp(value.checkedAt) ? value as FlowCollectionHealth : null;
  } catch { return null; }
}
/** Health is independent of posts and notification markers, including successful zero-message polls. */
export async function writeFlowCollectionHealth(health: FlowCollectionHealth): Promise<void> {
  writeJsonAtomic(optionFlowHealthPath(), health);
  if (!process.env.OPTION_FLOW_PATH && deskRemoteUrl(OPTION_FLOW_HEALTH_FILE)) await writeDeskJson(OPTION_FLOW_HEALTH_FILE, health);
}
