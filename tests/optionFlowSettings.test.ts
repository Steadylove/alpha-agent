import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PUT } from "@/app/api/push-routes/route";
import { defaultPushRoutes, pushRoutesOf, readPushRoutes } from "@/lib/notifications/pushRoutes";
import { filterForwardPost, optionFlowConfig } from "@/lib/optionFlow/config";
import { normalizeExpiry } from "@/lib/optionFlow/expiry";
import { noteworthyLayout, singleFlowLayout } from "@/lib/optionFlow/cardImage";
import type { OptionFlowPost } from "@/lib/optionFlow/types";

let root = "";
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "flow-settings-"));
  vi.stubEnv("PUSH_ROUTES_PATH", path.join(root, "routes.json"));
  vi.stubEnv("OPTION_FLOW_MIN_PREMIUM_USD", "");
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });
const request = (body: unknown) => new Request("http://localhost/api/push-routes", { method: "PUT", body: JSON.stringify(body) });

it("旧配置和未设环境变量默认 500K；非法值不能变成零门槛", () => {
  expect(optionFlowConfig().minPremiumUsd).toBe(500_000);
  expect(pushRoutesOf({ routes: {} }).optionFlowMinPremiumUsd).toBe(500_000);
  for (const value of [null, -1, "0", NaN, 0.5]) expect(pushRoutesOf({ optionFlowMinPremiumUsd: value }).optionFlowMinPremiumUsd).toBe(500_000);
  expect(pushRoutesOf({ optionFlowMinPremiumUsd: 0 }).optionFlowMinPremiumUsd).toBe(0);
});

it("网页金额配置持久化，旧客户端保留门槛，过期版本不覆盖", async () => {
  const settings = defaultPushRoutes();
  const saved = await PUT(request({ ...settings, optionFlowMinPremiumUsd: 1_000_000 }));
  expect(saved.status).toBe(200);
  const json = await saved.json();
  expect((await readPushRoutes()).optionFlowMinPremiumUsd).toBe(1_000_000);
  expect((await PUT(request({ ...settings, optionFlowMinPremiumUsd: 0 }))).status).toBe(409);
  settings.routes.book.enabled = false;
  expect((await PUT(request({ routes: settings.routes, updatedAt: json.updatedAt }))).status).toBe(200);
  const disk = JSON.parse(readFileSync(path.join(root, "routes.json"), "utf8"));
  expect(disk.optionFlowMinPremiumUsd).toBe(1_000_000);
  expect(disk.routes.book.enabled).toBe(false);
});

it.each([-1, "500k", null, 0.5, 1_000_000_000_001])("无效设置 %s 返回 400", async value => {
  expect((await PUT(request({ optionFlowMinPremiumUsd: value }))).status).toBe(400);
});

it("损坏的配置不能回退成较低门槛", async () => {
  writeFileSync(path.join(root, "routes.json"), "{broken");
  await expect(readPushRoutes({ strict: true })).rejects.toThrow();
});

it("确认名单逐笔筛选，不以合计金额放行小单，也不修改原始记录", () => {
  const legs = [499_999, 500_000, 700_000, undefined].map(premiumUsd => ({ ticker: "NVDA", strike: 200, expiry: "10/16/26", premiumUsd }));
  const original = { kind: "noteworthy", legs };
  const filtered = filterForwardPost(original, { minPremiumUsd: 500_000, dropAds: true, dropPaid: true });
  expect(filtered?.legs.map(l => l.premiumUsd)).toEqual([500_000, 700_000]);
  expect(original.legs).toHaveLength(4);
  expect(filterForwardPost({ ...original, legs: [legs[0], legs[0]] }, { minPremiumUsd: 500_000, dropAds: true, dropPaid: true })).toBeNull();
});

it("不同来源的确切到期日都格式化为 ISO 日期，并校验日期", () => {
  for (const value of ["10/16/26", "10/16/2026", "Oct 16", "October 16, 2026", "2026-10-16"]) expect(normalizeExpiry(value, "2026-09-22")).toBe("2026-10-16");
  expect(normalizeExpiry("01/15", "2026-12-22")).toBe("2027-01-15");
  expect(normalizeExpiry("02/30/26", "2026-09-22")).toBeUndefined();
  expect(normalizeExpiry("0DTE", "2026-09-22")).toBe("2026-09-22");
  expect(normalizeExpiry("Mar '27", "2026-09-22")).toBe("2027-03（月）");
  expect(normalizeExpiry("two weeks", "2026-09-22")).toBe("约 2 周后");
});

it("单笔和名单统一使用美东时间；夏冬令时及 0DTE 按美东日期", () => {
  const post: OptionFlowPost = { id: "preview", kind: "flow", postedAt: "2026-09-22T15:30:00Z", ingestedAt: "", thesis: "", rawText: "", imageUrls: [], imageProxyUrls: [], legs: [{ ticker: "NVDA", strike: 200, right: "call", expiry: "0DTE", premiumUsd: 600_000 }] };
  for (const layout of [singleFlowLayout(post), noteworthyLayout(post)]) {
    const texts = layout.items.flatMap(item => item.type === "text" ? [item.text] : []);
    expect(texts.some(t => t.startsWith("2026-09-22 11:30 美东时间"))).toBe(true);
    expect(texts).toContain("2026-09-22");
  }
  const texts = singleFlowLayout({ ...post, postedAt: "2026-01-16T01:30:00Z" }).items.flatMap(item => item.type === "text" ? [item.text] : []);
  expect(texts.some(t => t.startsWith("2026-01-15 20:30 美东时间"))).toBe(true);
  expect(texts).toContain("2026-01-15");
});
