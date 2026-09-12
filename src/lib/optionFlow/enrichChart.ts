import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { isCalendarExpiry } from "./config";
import { discordBotToken } from "./discordFetch";
import { ocrImageFile } from "./ocr";
import { mergeChartLeg, parseChartText } from "./parseChart";
import type { OptionFlowPost } from "./types";

function cacheFile(id: string): string {
  return path.join(/*turbopackIgnore: true*/ process.cwd(), ".tmp", "option-flow-shots", `${id}.jpg`);
}

export function needsChart(post: OptionFlowPost): boolean {
  if (post.kind !== "flow" || post.legs.length !== 1) return false;
  const leg = post.legs[0];
  return (leg.strike == null || !isCalendarExpiry(leg.expiry)) &&
    Boolean(post.imageProxyUrls[0] || post.imageUrls[0]);
}

async function download(url: string, dest: string): Promise<void> {
  mkdirSync(path.dirname(dest), { recursive: true });
  const res = await fetch(url, {
    headers: { authorization: `Bot ${discordBotToken()}`, "user-agent": "alpha-agent-option-flow" },
  });
  if (!res.ok) throw new Error(`拉配图失败 HTTP ${res.status}`);
  writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
}

export async function enrichFromChart(post: OptionFlowPost): Promise<OptionFlowPost> {
  if (!needsChart(post)) return post;
  const url = post.imageProxyUrls[0] || post.imageUrls[0];
  const file = cacheFile(post.id);
  if (!existsSync(file)) await download(url, file);
  const chart = parseChartText(ocrImageFile(file));
  if (!chart) return post;
  return { ...post, legs: post.legs.map((leg) => mergeChartLeg(leg, chart)) };
}
