import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { writeJsonAtomic } from "@/lib/files/atomicJson";

type Receipt = { status: "pending" | "sent" | "failed" | "uncertain"; at: string; messageId?: string };
type State = { version: 1; receipts: Record<string, Receipt> };
export class DefiniteDeliveryError extends Error {}
export const reviewDeliveryKey = (date: string, card: string, target: string) => createHash("sha256").update(`review-card:${date}:${card}:${target}`).digest("hex");

/** Caller holds the shared review-cards flock. Receipt granularity is card × destination. */
export async function deliverReviewCard(file: string, key: string, send: () => Promise<string | undefined>, idempotent = false) {
  const state = (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { version: 1, receipts: {} }) as State;
  if (state.version !== 1 || !state.receipts || Object.values(state.receipts).some(r => !["pending", "sent", "failed", "uncertain"].includes(r.status))) throw new Error("推送回执无效，停止以防重复");
  const prior = state.receipts[key];
  if (prior?.status === "sent") return "duplicate";
  if (!idempotent && (prior?.status === "pending" || prior?.status === "uncertain")) throw new Error("该图发送结果待核验，已阻止自动重复发送");
  const mark = (status: Receipt["status"], messageId?: string) => {
    state.receipts[key] = { status, at: new Date().toISOString(), ...(messageId ? { messageId } : {}) };
    writeJsonAtomic(file, state);
  };
  mark("pending");
  try {
    const messageId = await send();
    mark("sent", messageId);
    return "sent";
  } catch (error) {
    mark(idempotent || error instanceof DefiniteDeliveryError ? "failed" : "uncertain");
    throw error;
  }
}

/** One attempt with wait=true. Ambiguous network errors are reconciled, never blindly resent. */
export async function postReviewDiscordImage(url: string, image: { filename: string; bytes: Buffer; content: string }): Promise<string> {
  const target = new URL(url); target.searchParams.set("wait", "true");
  const body = new FormData();
  body.append("payload_json", JSON.stringify({ content: image.content, allowed_mentions: { parse: [] }, embeds: [{ color: 0x9ed6bc, image: { url: `attachment://${image.filename}` } }] }));
  body.append("files[0]", new Blob([new Uint8Array(image.bytes)], { type: "image/png" }), image.filename);
  let response: Response;
  try { response = await fetch(target, { method: "POST", body, signal: AbortSignal.timeout(45_000) }); }
  catch { throw new Error("Discord 网络响应不确定，需核对频道后再重发"); }
  if (response.status >= 400 && response.status < 500) throw new DefiniteDeliveryError(`Discord 拒绝发送 HTTP ${response.status}`);
  if (!response.ok) throw new Error(`Discord 响应不确定 HTTP ${response.status}`);
  const message = await response.json() as { id?: string };
  if (!message.id) throw new Error("Discord 未返回消息回执");
  return message.id;
}
