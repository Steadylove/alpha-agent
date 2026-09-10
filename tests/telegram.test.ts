import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { TelegramStore } from "@/lib/telegram/store";
import { TelegramClient, TelegramError } from "@/lib/telegram/client";
import { processTelegramUpdate, type TelegramUpdate } from "@/lib/telegram/updates";
import { deliverTelegram } from "@/lib/telegram/delivery";

let dir: string, store: TelegramStore;
const bot = { id: 777, username: "ExampleBot" };
const call = vi.fn(), sendPhoto = vi.fn();
const api = { call, sendPhoto } as unknown as TelegramClient;
const id = (s: string) => createHash("sha256").update(s).digest("hex");
const chat = (n = -1) => ({ id: n, type: "supergroup", title: "测试群" });
const join = (update_id: number, groupId = -1, status = "member"): TelegramUpdate => ({ update_id,
  my_chat_member: { chat: chat(groupId), date: update_id, old_chat_member: { status: "left" }, new_chat_member: { status } } });
const command = (update_id: number, text: string): TelegramUpdate => ({ update_id,
  message: { chat: chat(), date: update_id, text, from: { id: 10 } } });
const add = (n: number) => { store.state.groups[String(n)] = { id: String(n), title: "Group", present: true, writable: true, paused: false, updatedAt: 0, nextSendAt: 0 }; store.saveState(); };
beforeEach(() => { dir = mkdtempSync(`${tmpdir()}/telegram-`); store = new TelegramStore(dir); vi.resetAllMocks(); call.mockResolvedValue({ message_id: 1 }); sendPhoto.mockResolvedValue({ message_id: 2, photo: [{ file_id: "photo-id" }] }); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("Telegram 群订阅", () => {
  it("入群自动订阅，重启保留群和更新游标，重复事件不重复欢迎", async () => {
    await processTelegramUpdate(store, api, bot, join(1));
    expect(store.stats().subscribed).toBe(1);
    store = new TelegramStore(dir);
    expect(store.state.offset).toBe(2);
    await processTelegramUpdate(store, api, bot, join(1));
    expect(store.jobs.size).toBe(1);
    store.enqueue(id("signal"), "买点", "png");
    expect(store.jobs.get(id("signal"))!.deliveries[0].chatId).toBe("-1");
  });
  it("离群停止推送并取消待发信号，不影响其他群", async () => {
    add(-1); add(-2); store.enqueue(id("signal"), "signal", "png");
    await processTelegramUpdate(store, api, bot, join(5, -1, "kicked"));
    expect(store.stats().subscribed).toBe(1);
    expect(store.jobs.get(id("signal"))!.deliveries.map((d) => d.state)).toEqual(["skipped", "pending"]);
  });
  it("普通成员不能暂停；管理员可暂停并恢复，权限升级不取消手动暂停", async () => {
    add(-1);
    call.mockResolvedValue([{ user: { id: 99 }, status: "administrator" }]);
    await processTelegramUpdate(store, api, bot, command(1, "/pause"));
    expect(store.state.groups['-1'].paused).toBe(false);
    call.mockResolvedValue([{ user: { id: 10 }, status: "creator" }]);
    await processTelegramUpdate(store, api, bot, command(2, "/pause@ExampleBot"));
    expect(store.state.groups['-1'].paused).toBe(true);
    const promoted = join(3, -1, "administrator"); promoted.my_chat_member!.old_chat_member.status = "member";
    await processTelegramUpdate(store, api, bot, promoted);
    expect(store.state.groups['-1'].paused).toBe(true);
    call.mockResolvedValueOnce([{ user: { id: 10 }, status: "creator" }]).mockResolvedValueOnce({ status: "member" });
    await processTelegramUpdate(store, api, bot, command(4, "/resume"));
    expect(store.stats().subscribed).toBe(1);
  });
  it("仅本群匿名管理员有权限，发送给其他机器人的命令不处理", async () => {
    add(-1);
    const c = command(1, "/pause"); c.message!.sender_chat = { id: -1 };
    await processTelegramUpdate(store, api, bot, c);
    expect(store.state.groups['-1'].paused).toBe(true);
    expect(call).not.toHaveBeenCalled();
    await processTelegramUpdate(store, api, bot, command(2, "/resume@OtherBot"));
    expect(store.state.groups['-1'].paused).toBe(true);
  });
  it("权限不足不订阅；管理员权限检查失败时保留游标供重试", async () => {
    const u = join(1); u.my_chat_member!.new_chat_member = { status: "restricted", is_member: true, can_send_messages: true, can_send_photos: false };
    await processTelegramUpdate(store, api, bot, u);
    expect(store.stats().subscribed).toBe(0);
    call.mockRejectedValue(new TelegramError(500));
    await expect(processTelegramUpdate(store, api, bot, command(2, "/resume"))).rejects.toThrow();
    expect(new TelegramStore(dir).state.offset).toBe(2);
  });
  it("升级超级群保留暂停状态并迁移待发收件人，迟到的旧群事件不重新注册", async () => {
    add(-1); store.enqueue(id("signal"), "signal", "png");
    store.state.groups['-1'].paused = true;
    await processTelegramUpdate(store, api, bot, { update_id: 1, message: { chat: chat(), date: 1, migrate_to_chat_id: -100 } });
    expect(store.state.groups['-100'].paused).toBe(true);
    expect(store.jobs.get(id("signal"))!.deliveries[0].chatId).toBe("-100");
    await processTelegramUpdate(store, api, bot, join(2));
    expect(store.state.groups['-1'].present).toBe(false);
    expect(new TelegramStore(dir).state.groups['-100'].paused).toBe(true);
    await processTelegramUpdate(store, api, bot, join(3, -100));
    expect(store.state.groups['-100'].paused).toBe(true);
  });
  it("私聊只提供帮助，不自动成为广播订阅；群聊闲聊不处理", async () => {
    await processTelegramUpdate(store, api, bot, { update_id: 1, message: { chat: { id: 5, type: "private" }, date: 1, text: "/start" } });
    await processTelegramUpdate(store, api, bot, command(2, "hello"));
    expect(store.stats().subscribed).toBe(0);
    expect(store.jobs.size).toBe(1);
    expect(call).not.toHaveBeenCalled();
  });
});

describe("Telegram 持久化投递", () => {
  it("同一信号重跑不重复入队，完成后重启仍能去重，新增群只收新信号", async () => {
    add(-1); store.enqueue(id("same"), "signal", "png", undefined, 1000);
    await deliverTelegram(store, api, 1000);
    store = new TelegramStore(dir); add(-2);
    expect(store.enqueue(id("same"), "signal", "png").duplicate).toBe(true);
    expect(await deliverTelegram(store, api, 5000)).toBe(false);
    expect(sendPhoto).toHaveBeenCalledTimes(1);
    expect(store.jobs.get(id("same"))!.png).toBeUndefined();
    expect(store.enqueue(id("next"), "next", "png").recipients).toBe(2);
  });
  it("某群临时失败不阻塞其他群，重启后继续重试且成功群不重发", async () => {
    add(-1); add(-2); store.enqueue(id("signal"), "signal", "png", undefined, 1000);
    sendPhoto.mockRejectedValueOnce(new TelegramError(500));
    await deliverTelegram(store, api, 1000); await deliverTelegram(store, api, 1001);
    expect(sendPhoto.mock.calls.map((c) => c[0])).toEqual(["-1", "-2"]);
    store = new TelegramStore(dir);
    await deliverTelegram(store, api, 4101);
    expect(store.stats().sent).toBe(2);
    expect(sendPhoto.mock.calls.map((c) => c[0])).toEqual(["-1", "-2", "-1"]);
    expect(sendPhoto.mock.calls[2][3]).toBe("photo-id");
  });
  it("尊重每群发送间隔与 Telegram retry_after，冷却时间跨重启保存", async () => {
    add(-1); add(-2); store.enqueue(id("signal"), "signal", "png", undefined, 1000);
    sendPhoto.mockRejectedValueOnce(new TelegramError(429, 10));
    await deliverTelegram(store, api, 1000);
    store = new TelegramStore(dir);
    expect(await deliverTelegram(store, api, 9999)).toBe(false);
    await deliverTelegram(store, api, 11001);
    expect(sendPhoto).toHaveBeenCalledTimes(2);
    store.enqueue(id("next"), "next", "png", undefined, 11001);
    await deliverTelegram(store, api, 11002);
    expect(await deliverTelegram(store, api, 11003)).toBe(false);
  });
  it("403 停止无权限群，其余群继续；参数错误不会无限重试", async () => {
    add(-1); add(-2); store.enqueue(id("signal"), "signal", "png", undefined, 1000);
    sendPhoto.mockRejectedValueOnce(new TelegramError(403)).mockRejectedValueOnce(new TelegramError(400));
    await deliverTelegram(store, api, 1000); await deliverTelegram(store, api, 1001);
    expect(store.stats()).toMatchObject({ subscribed: 1, skipped: 1, failed: 1 });
    expect(await deliverTelegram(store, api, 999999)).toBe(false);
  });
  it("迁移错误自动重定向待发消息，不把新群停用", async () => {
    add(-1); store.enqueue(id("signal"), "signal", "png", undefined, 1000);
    sendPhoto.mockRejectedValueOnce(new TelegramError(400, 0, -100));
    await deliverTelegram(store, api, 1000); await deliverTelegram(store, api, 5000);
    expect(sendPhoto.mock.calls.map((c) => c[0])).toEqual(["-1", "-100"]);
    expect(store.stats().sent).toBe(1);
  });
  it("过期信号不会在恢复服务后补发", async () => {
    add(-1); store.enqueue(id("old"), "signal", "png", undefined, 0);
    await deliverTelegram(store, api, 24 * 3600_000 + 1);
    expect(sendPhoto).not.toHaveBeenCalled(); expect(store.stats().skipped).toBe(1);
  });
});
