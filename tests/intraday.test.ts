import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IntradayStore, validDate } from "@/lib/intraday/store";
import { intradaySignalSchema, sessionDate, signalId, signalMessage, tradeId, type IntradaySignal } from "@/lib/intraday/protocol";
import { deliverIntraday } from "@/lib/intraday/delivery";
import { defaultPushRoutes } from "@/lib/notifications/pushRoutesLogic";
import { TelegramStore } from "@/lib/telegram/store";
import { deliverTelegram } from "@/lib/telegram/delivery";
import { TelegramClient } from "@/lib/telegram/client";
import { createTelegramRelayServer } from "@/lib/telegram/relayServer";
import { relayHeaders } from "@/lib/telegram/relayAuth";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { force: true, recursive: true }); vi.restoreAllMocks(); });
const temporary = () => { const d = mkdtempSync(path.join(tmpdir(), "intraday-")); dirs.push(d); return d; };
const now = Date.parse("2026-09-28T12:01:00Z");
function payload(overrides: Partial<IntradaySignal> = {}): IntradaySignal {
  return { protocol: "intraday-v1", strategy: "resonance-long", scriptVersion: "1.0.0", strategyKey: "default",
    symbol: "NASDAQ:TEST", tf: "1", event: "entry", reason: "premium_resonance", barTime: now - 60_000, signalTime: now,
    entrySignalTime: now, price: 3.5, entryPrice: 3.5, stop: 3.2, metrics: { trend: 25, premium: true, rvol: 6.1, gainPct: 40 }, parameters: { buyCooldown: 4 }, ...overrides };
}
function setup() {
  const root = temporary(), store = new IntradayStore(path.join(root, "intraday")), telegram = new TelegramStore(path.join(root, "telegram"));
  telegram.state.groups["-1"] = { id: "-1", title: "Test", present: true, writable: true, paused: false, updatedAt: 0, nextSendAt: 0 };
  telegram.saveState();
  const file = defaultPushRoutes();
  file.routes["signal-intraday"].enabled = true;
  const config = () => ({ file, lookup: () => "https://discord.com/api/webhooks/123/example" });
  return { root, store, telegram, file, config };
}

describe("日内信号档案", () => {
  it("返回成功前落盘；重复/内容冲突不覆盖原始信号，所有到达记入收件日志", () => {
    const { root, store } = setup(), p = payload();
    const result = store.accept(p, now + 100);
    expect(result).toMatchObject({ recorded: true, duplicate: false, disposition: "accepted" });
    const restarted = new IntradayStore(path.join(root, "intraday"));
    expect(restarted.pending.get(result.id)?.payload).toEqual(p);
    expect(restarted.accept(p, now + 1000)).toMatchObject({ duplicate: true, conflict: false });
    const changed = payload({ price: 3.6, entryPrice: 3.6 });
    expect(restarted.accept(changed, now + 2000)).toMatchObject({ duplicate: true, conflict: true });
    expect(restarted.list("2026-09-28")[0].payload.price).toBe(3.5);
    const receipts = readFileSync(path.join(root, "intraday/2026-09-28/receipts.ndjson"), "utf8").trim().split("\n").map(s => JSON.parse(s));
    expect(receipts.map(r => r.status)).toEqual(["accepted", "duplicate", "conflict"]);
    expect(receipts[2].payload.price).toBe(3.6);
  });
  it("延迟和未来信号保存但不发送；停推也保留记录", async () => {
    const { store, telegram, config, file } = setup();
    expect(store.accept(payload(), now + 120001).disposition).toBe("stale");
    expect(store.pending.size).toBe(0);
    expect(store.accept(payload({ strategyKey: "future" }), now - 30001).disposition).toBe("future");
    const p = payload({ strategyKey: "disabled" }); store.accept(p, now);
    file.routes["signal-intraday"].enabled = false;
    await deliverIntraday(store, telegram, config, true, now);
    expect(store.get("2026-09-28", signalId(p))).toMatchObject({ state: "skipped", reason: "route_disabled" });
    expect(store.list("2026-09-28")).toHaveLength(3);
  });
  it("关联靠策略参数+原始入场时间；不同版本、股票、参数不串单", () => {
    const entry = payload(), exit = payload({ event: "exit", reason: "resonance_top", signalTime: now + 60000, barTime: now, price: 4 });
    expect(tradeId(entry)).toBe(tradeId(exit)); expect(signalId(entry)).not.toBe(signalId(exit));
    for (const change of [{ scriptVersion: "1.0.1" }, { strategyKey: "other" }, { symbol: "NYSE:TEST" }]) expect(tradeId(payload(change))).not.toBe(tradeId(entry));
    expect(intradaySignalSchema.safeParse(payload({ stop: 4 })).success).toBe(false);
    expect(intradaySignalSchema.safeParse(payload({ tf: "4H" as "1" })).success).toBe(false);
    expect(intradaySignalSchema.safeParse({ ...entry, secret: "unexpected" }).success).toBe(false);
  });
  it("乱序收到退出时标记缺少入场，后补入场可关联但不改写当时的观测", () => {
    const { store } = setup(), entry = payload(), exit = payload({ event: "exit", reason: "resonance_top", signalTime: now + 60000, barTime: now, price: 4 });
    store.accept(exit, now + 60000);
    expect(store.hasEntry(exit)).toBe(false);
    expect(store.get("2026-09-28", signalId(exit))?.entrySeenAtReceipt).toBe(false);
    store.accept(entry, now + 60001);
    expect(store.hasEntry(exit)).toBe(true);
    expect(store.get("2026-09-28", signalId(exit))?.entrySeenAtReceipt).toBe(false);
  });
  it("按美东交易日分档，拒绝日期穿越；信息使用 ET 和信号价", () => {
    expect(sessionDate(Date.parse("2026-09-29T01:00:00Z"))).toBe("2026-09-28");
    expect(validDate("../../private")).toBe(false); expect(validDate("2026-02-31")).toBe(false);
    expect(signalMessage(payload(), signalId(payload()))).toContain("2026-09-28 08:01:00 ET");
    expect(signalMessage(payload(), signalId(payload()))).toContain("信号价不代表成交");
  });
});

describe("持久化转发队列", () => {
  it("DC 失败可重试，TG 已入队不重复；重启保留进度且可核对实际 TG 发送结果", async () => {
    const { root, store, telegram, config } = setup(), p = payload(); store.accept(p, now);
    const fetcher = vi.fn().mockResolvedValueOnce(new Response("", { status: 503 })).mockResolvedValueOnce(new Response('{"id":"dc-msg"}'));
    await deliverIntraday(store, telegram, config, true, now, fetcher);
    await deliverIntraday(store, telegram, config, true, now + 1, fetcher);
    expect(telegram.jobs.size).toBe(1);
    const restarted = new IntradayStore(path.join(root, "intraday"));
    await deliverIntraday(restarted, telegram, config, true, now + 5000, fetcher);
    const tgJob = [...telegram.jobs.values()][0]; tgJob.deliveries[0].state = "sent"; tgJob.deliveries[0].messageId = 7; telegram.saveJob(tgJob);
    await deliverIntraday(restarted, telegram, config, true, now + 6000, fetcher);
    const row = restarted.get("2026-09-28", signalId(p))!;
    expect(row.state).toBe("done"); expect(row.deliveries?.map(d => d.state)).toEqual(["sent", "sent"]);
    expect(fetcher).toHaveBeenCalledTimes(2); expect(telegram.jobs.size).toBe(1);
    expect(JSON.stringify(row)).not.toContain("api/webhooks");
    expect(JSON.parse(fetcher.mock.calls[0][1].body).allowed_mentions).toEqual({ parse: [] });
  });
  it("路由故障不丢信号，超过时效停止补发；TG 排队也遵守短期时效", async () => {
    const { store, telegram, config, file } = setup(); const p = payload(); store.accept(p, now);
    const fetcher = vi.fn();
    await deliverIntraday(store, telegram, () => { throw new Error("routing"); }, true, now, fetcher);
    expect(store.get("2026-09-28", signalId(p))?.reason).toBe("routing_unavailable");
    file.routes["signal-intraday"].discord = false;
    await deliverIntraday(store, telegram, config, true, now + 1000, fetcher);
    const api = new TelegramClient("fake"), send = vi.spyOn(api, "call");
    await deliverTelegram(telegram, api, now + 180001);
    await deliverIntraday(store, telegram, config, true, now + 180002, fetcher);
    expect(send).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled();
    expect(store.get("2026-09-28", signalId(p))?.deliveries?.[0].state).toBe("skipped");
  });
  it("一个 DC 频道成功、另一个失败，重试仅发送失败目标", async () => {
    const { store, telegram, config, file } = setup(); store.accept(payload(), now);
    file.routes["signal-intraday"].telegram = false;
    file.routes["signal-intraday"].discordWebhooks = ["https://discord.com/api/webhooks/1/first", "https://discord.com/api/webhooks/2/second"];
    const fetcher = vi.fn().mockResolvedValueOnce(new Response('{"id":"first"}')).mockResolvedValueOnce(new Response("", { status: 503 })).mockResolvedValueOnce(new Response('{"id":"second"}'));
    for (const offset of [0, 1, 5000, 6000]) await deliverIntraday(store, telegram, config, true, now + offset, fetcher);
    expect(fetcher.mock.calls.map(c => String(c[0]))).toEqual(["https://discord.com/api/webhooks/1/first?wait=true", "https://discord.com/api/webhooks/2/second?wait=true", "https://discord.com/api/webhooks/2/second?wait=true"]);
    expect(store.pending.size).toBe(0);
  });
  it("空订阅群不会标成发送成功；缺少频道配置也留失败记录", async () => {
    const { store, telegram, file } = setup(); store.accept(payload(), now); telegram.state.groups = {};
    await deliverIntraday(store, telegram, () => ({ file, lookup: () => "" }), true, now);
    await deliverIntraday(store, telegram, () => ({ file, lookup: () => "" }), true, now + 1);
    const row = store.get("2026-09-28", signalId(payload()))!;
    expect(row.deliveries?.map(d => d.error)).toEqual(["no_discord_destination", "no_telegram_destination"]);
  });
});

it("真实 HTTP 接口：鉴权后才可存档/读取；成功时已在磁盘，重放幂等", async () => {
  const { store, telegram } = setup();
  const server = createTelegramRelayServer(telegram, "relay-test", true, () => ({ ok: false }), "", undefined, undefined, { store, secret: "a".repeat(64) });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const p = payload(), raw = JSON.stringify(p);
  const post = (name: string, body: string) => fetch(`${base}/${name}`, { method: "POST", headers: relayHeaders("relay-test", body), body });
  try {
    expect((await fetch(`${base}/intraday/ingest`, { method: "POST", body: raw })).status).toBe(401);
    expect((await post("intraday/ingest", '{"bad":true}')).status).toBe(400);
    expect((await post("intraday/ingest", '"' + "x".repeat(17000) + '"')).status).toBe(413);
    expect(await (await post("intraday/ingest", raw)).json()).toMatchObject({ recorded: true, duplicate: false });
    expect(store.list("2026-09-28")).toHaveLength(1);
    expect(await (await post("intraday/ingest", raw)).json()).toMatchObject({ recorded: true, duplicate: true });
    expect((await post("intraday/journal", '{"date":"../secrets"}')).status).toBe(400);
    const response = await post("intraday/journal", '{"date":"2026-09-28"}');
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect((await response.json()).records[0].payload).toEqual(p);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
