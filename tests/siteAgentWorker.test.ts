import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { PassThrough } from "node:stream";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentStore } from "../services/site-agent/store";
import { AgentService } from "../services/site-agent/service";
import type { AgentRpc, RpcMessage } from "../services/site-agent/rpc";

const spawnLogin = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ spawn: spawnLogin }));
class LoginChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  kill = vi.fn(() => true);
}

type Params = Record<string, unknown>;
class FakeRpc extends EventEmitter implements AgentRpc {
  calls: { method: string; params: Params }[] = [];
  responses: { id: string | number; result: unknown }[] = [];
  stopped = 0;
  serial = 0;
  handler?: (method: string, params: Params) => unknown | Promise<unknown>;
  async ensure() {}
  async call<T = Params>(method: string, params: Params = {}): Promise<T> {
    this.calls.push({ method, params });
    const overridden = this.handler?.(method, params);
    if (overridden !== undefined) return await overridden as T;
    const defaults: Record<string, unknown> = {
      "account/read": { account: { type: "chatgpt", planType: "plus" } },
      "model/list": { data: [{ model: "example-model", displayName: "Example", isDefault: true, defaultReasoningEffort: "medium", supportedReasoningEfforts: [{ reasoningEffort: "medium" }] }] },
      "account/rateLimits/read": { rateLimits: { primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1_900_000_000 } } },
      "thread/start": { thread: { id: "native-thread" }, activePermissionProfile: { id: (params.config as Params)?.default_permissions }, approvalPolicy: params.approvalPolicy },
      "thread/resume": { thread: { id: "native-thread" }, activePermissionProfile: { id: (params.config as Params)?.default_permissions }, approvalPolicy: params.approvalPolicy },
      "turn/start": { turn: { id: `native-turn-${++this.serial}` } },
      "turn/interrupt": {},
    };
    return defaults[method] as T;
  }
  respond(id: string | number, result: unknown) { this.responses.push({ id, result }); }
  stop() { this.stopped++; this.emit("disconnect", {}); }
  notification(method: string, params: Params) { this.emit("notification", { method, params } satisfies RpcMessage); }
  request(id: number, method: string, params: Params) { this.emit("request", { id, method, params } satisfies RpcMessage); }
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const fixtures: { directory: string; service: AgentService }[] = [];
function fixture() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "site-agent-worker-test-"));
  const store = new AgentStore(directory), rpc = new FakeRpc();
  const service = new AgentService(store, rpc, { workspace: directory, home: directory, executable: "unused-test-only" });
  fixtures.push({ directory, service });
  return { directory, store, rpc, service, thread: service.create({ mode: "research" }) };
}
const settle = () => new Promise<void>(resolve => setImmediate(resolve));
async function running() { const value = fixture(); await value.service.send(value.thread.id, "Research this"); await settle(); return value; }
const activeTurn = (store: AgentStore, id: string) => store.get(id).activeTurnId;
afterEach(() => { for (const value of fixtures.splice(0)) { value.service.close(); rmSync(value.directory, { recursive: true, force: true }); } spawnLogin.mockReset(); vi.useRealTimers(); });

describe("site agent device login", () => {
  it("forces new conversations into read-only research mode and blocks legacy workspace sends", async () => {
    const { service, store } = fixture();
    const created = service.create({ mode: "workspace" });
    expect(created.mode).toBe("research");
    store.get(created.id).mode = "workspace";
    await expect(service.send(created.id, "Should not run")).rejects.toMatchObject({ status: 409 });
  });

  it("preserves an existing Pro account on startup without another login or RPC restart", async () => {
    const { service, rpc } = fixture();
    rpc.handler = method => method === "account/read" ? { account: { type: "chatgpt", planType: "pro" } } : undefined;
    const status = await service.status();
    expect(status).toMatchObject({ authenticated: true, account: { type: "chatgpt", plan: "pro" }, login: { status: "idle" } });
    expect(spawnLogin).not.toHaveBeenCalled();
    expect(rpc.stopped).toBe(0);
  });

  it("allows retry after spawn failure and ignores late callbacks from the failed process", async () => {
    const { service } = fixture(), first = new LoginChild(), second = new LoginChild();
    spawnLogin.mockReturnValueOnce(first).mockReturnValueOnce(second);
    service.startLogin(); first.emit("error", new Error("private startup detail"));
    expect((await service.status()).login).toEqual({ status: "failed", error: "无法启动 Codex 设备授权" });
    service.startLogin(); first.emit("exit", 0, null);
    expect((await service.status()).login.status).toBe("pending");
    second.emit("exit", 1, null);
    expect((await service.status()).login.status).toBe("failed");
    expect(spawnLogin).toHaveBeenCalledTimes(2);
  });

  it("reports verification RPC failure without treating zero exit as success or exposing the raw error", async () => {
    const { service, rpc } = fixture(), child = new LoginChild();
    spawnLogin.mockReturnValue(child);
    rpc.handler = method => { if (method === "account/read") throw new Error("private provider detail"); };
    service.startLogin(); child.emit("exit", 0, null); await settle();
    const status = await service.status();
    expect(status.login).toEqual({ status: "failed", error: "无法确认账号授权状态，请刷新后重试。" });
    expect(status.authenticated).toBe(false);
  });

  it("confirms the new account even if stopping the old RPC rejects an in-flight status refresh", async () => {
    const { service, rpc } = fixture(), child = new LoginChild();
    let rejectStale!: (reason: Error) => void, accountCalls = 0;
    const stale = new Promise<Params>((_, reject) => { rejectStale = reject; });
    rpc.handler = method => method === "account/read" ? (++accountCalls === 1 ? stale : { account: { type: "chatgpt", planType: "pro" } }) : undefined;
    spawnLogin.mockReturnValue(child);
    const previous = service.status(); await settle();
    service.startLogin(); child.emit("exit", 0, null);
    rejectStale(new Error("old process disconnected")); await previous; await settle();
    expect(await service.status()).toMatchObject({ authenticated: true, account: { plan: "pro" }, login: { status: "complete" } });
    expect(accountCalls).toBe(2);
  });

  it("keeps an active login failed after shutdown even if the wrapper later exits zero", async () => {
    const { service } = fixture(), child = new LoginChild();
    spawnLogin.mockReturnValue(child);
    service.startLogin(); service.close(); child.emit("exit", 0, null); await settle();
    expect((await service.status()).login.status).toBe("failed");
    expect(child.kill).toHaveBeenCalledOnce();
  });

  it("does not treat a zero exit without an account as completed authorization", async () => {
    const { service, rpc } = fixture(), child = new LoginChild();
    rpc.handler = method => method === "account/read" ? { account: null } : undefined;
    spawnLogin.mockReturnValue(child);
    service.startLogin(); child.emit("exit", 0, null); await settle();
    const status = await service.status();
    expect(status.login.status).toBe("failed");
    expect(status.authenticated).toBe(false);
  });

  it("marks timeouts failed even when the npm wrapper later exits zero and rejects stale callbacks", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { service, rpc } = fixture(), first = new LoginChild(), second = new LoginChild();
    rpc.handler = method => method === "account/read" ? { account: null } : undefined;
    spawnLogin.mockReturnValueOnce(first).mockReturnValueOnce(second);
    service.startLogin(); service.startLogin();
    expect(spawnLogin).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    expect(first.kill).toHaveBeenCalledOnce();
    expect((await service.status()).login.status).toBe("failed");
    service.startLogin();
    expect(spawnLogin).toHaveBeenCalledTimes(1); // Do not overlap a still-stopping login process.
    first.emit("exit", 0, null);
    expect((await service.status()).login.status).toBe("failed");
    service.startLogin();
    first.stdout.write("https://auth.openai.com/device OLD1-OLD2\n");
    first.emit("exit", 0, null);
    first.emit("error", new Error("late callback"));
    expect((await service.status()).login).toEqual({ status: "pending" });
    expect(spawnLogin).toHaveBeenCalledTimes(2);
  });

  it("keeps shutdown failed when an exited login is still awaiting account verification", async () => {
    const { service, rpc } = fixture(), child = new LoginChild(), account = deferred<Params>();
    spawnLogin.mockReturnValue(child);
    rpc.handler = method => method === "account/read" ? account.promise : undefined;
    service.startLogin(); child.emit("exit", 0, null); await settle();
    service.close();
    account.resolve({ account: { type: "chatgpt" } }); await settle();
    expect((await service.status()).login.status).toBe("failed");
    expect(() => service.startLogin()).toThrow();
  });

  it.each([null, { type: "chatgpt" }])("verifies a fresh account after an older status refresh settles (%j)", async freshAccount => {
    const { service, rpc } = fixture(), child = new LoginChild(), stale = deferred<Params>(), fresh = deferred<Params>();
    let accountCalls = 0;
    rpc.handler = method => method === "account/read" ? (++accountCalls === 1 ? stale.promise : fresh.promise) : undefined;
    spawnLogin.mockReturnValue(child);
    const previousStatus = service.status(); await settle();
    service.startLogin(); child.emit("exit", 0, null);
    service.startLogin();
    expect(spawnLogin).toHaveBeenCalledTimes(1);
    stale.resolve({ account: freshAccount ? null : { type: "chatgpt" } });
    await previousStatus; await settle();
    expect(accountCalls).toBe(2);
    fresh.resolve({ account: freshAccount }); await settle();
    const status = await service.status();
    expect(status.authenticated).toBe(!!freshAccount);
    expect(status.login.status).toBe(freshAccount ? "complete" : "failed");
  });
});

describe("site agent worker lifecycle", () => {
  it("applies native denied paths and never enables sandbox escape approval", async () => {
    const { rpc, directory } = await running();
    const request = rpc.calls.find(call => call.method === "thread/start")!.params;
    expect(request).not.toHaveProperty("sandbox");
    expect(request.approvalPolicy).toMatchObject({ granular: { sandbox_approval: false, request_permissions: false, rules: true } });
    expect(request.config).toMatchObject({ default_permissions: "site-research", permissions: { "site-research": {
      extends: ":read-only", filesystem: { [directory]: "deny", "/state": "deny", "/proc": "deny", "/market": "read" }, network: { enabled: false },
    } } });
  });

  it("does not send a model turn when the native profile is missing or escalation is enabled", async () => {
    for (const response of [
      { approvalPolicy: { granular: { sandbox_approval: false, request_permissions: false } } },
      { activePermissionProfile: { id: "site-research" } },
      { activePermissionProfile: { id: "site-research" }, approvalPolicy: { granular: { sandbox_approval: true, request_permissions: false } } },
      { activePermissionProfile: { id: "site-research" }, approvalPolicy: { granular: { sandbox_approval: false, request_permissions: true } } },
    ]) {
      const { service, rpc, thread } = fixture();
      rpc.handler = method => method === "thread/start" ? { thread: { id: "native-thread" }, ...response } : undefined;
      await service.send(thread.id, "Check permissions"); await settle();
      expect(rpc.calls.some(call => call.method === "turn/start")).toBe(false);
      expect(rpc.stopped).toBeGreaterThan(0);
    }
  });
  it("reserves the sole execution slot before account IO resolves", async () => {
    const { service, rpc, thread } = fixture();
    const account = deferred<Params>();
    rpc.handler = method => method === "account/read" ? account.promise : undefined;
    const first = service.send(thread.id, "First message");
    await expect(service.send(thread.id, "Second message")).rejects.toMatchObject({ status: 409 });
    account.resolve({ account: { type: "chatgpt" } });
    await first; await settle();
    expect(rpc.calls.filter(call => call.method === "turn/start")).toHaveLength(1);
  });

  it("does not start a cancelled send after a new send takes the same thread slot", async () => {
    const { service, rpc, thread, store } = fixture();
    const account = deferred<Params>();
    rpc.handler = method => method === "account/read" ? account.promise : undefined;
    const stale = service.send(thread.id, "Cancelled input");
    await settle();
    await service.interrupt(thread.id);
    const current = service.send(thread.id, "Current input");
    account.resolve({ account: { type: "chatgpt" } });
    await Promise.all([stale, current]); await settle();
    expect(store.get(thread.id).messages.filter(message => message.role === "user").map(message => message.text)).toEqual(["Current input"]);
    expect(rpc.calls.filter(call => call.method === "turn/start")).toHaveLength(1);
    expect(store.usage().turns).toBe(1);
  });

  it("waits for a turn ID then interrupts a pending turn start", async () => {
    const { service, rpc, thread, store } = fixture();
    const turn = deferred<Params>();
    rpc.handler = method => method === "turn/start" ? turn.promise : undefined;
    await service.send(thread.id, "Start"); await settle();
    const cancelled = service.interrupt(thread.id);
    turn.resolve({ turn: { id: "delayed-turn" } });
    await cancelled;
    expect(store.get(thread.id).status).toBe("interrupted");
    expect(rpc.calls).toContainEqual({ method: "turn/interrupt", params: { threadId: "native-thread", turnId: "delayed-turn" } });
  });

  it("ignores old-turn messages, approval requests and completion after the next turn starts", async () => {
    const { service, rpc, thread, store } = await running();
    const oldTurn = activeTurn(store, thread.id)!;
    await service.interrupt(thread.id);
    await service.send(thread.id, "Next turn"); await settle();
    const newTurn = activeTurn(store, thread.id)!;
    rpc.notification("item/agentMessage/delta", { threadId: "native-thread", turnId: oldTurn, itemId: "stale-answer", delta: "Old output" });
    rpc.request(88, "item/commandExecution/requestApproval", { threadId: "native-thread", turnId: oldTurn, itemId: "old-command", command: "echo old" });
    rpc.notification("turn/completed", { threadId: "native-thread", turn: { id: oldTurn, status: "interrupted" } });
    expect(store.get(thread.id).status).toBe("running");
    expect(activeTurn(store, thread.id)).toBe(newTurn);
    expect(store.get(thread.id).messages.some(message => message.id === "stale-answer")).toBe(false);
    expect(store.get(thread.id).approvals).toEqual([]);
    expect(rpc.responses.find(response => response.id === 88)?.result).not.toEqual({ decision: "accept" });
  });

  it("stops the native process when turn start times out with an unknown execution outcome", async () => {
    const { service, rpc, thread, store } = fixture();
    rpc.handler = method => { if (method === "turn/start") return Promise.reject(new Error("Codex 请求超时，请检查服务状态")); };
    await service.send(thread.id, "May already be executing"); await settle();
    expect(store.get(thread.id).status).not.toBe("running");
    expect(rpc.stopped).toBeGreaterThan(0);
  });

  it("preserves the sanitized startup failure when stopping RPC emits disconnect", async () => {
    const { service, rpc, thread, store, directory } = fixture();
    rpc.handler = method => method === "thread/start" ? Promise.reject(new Error("权限配置未生效 sk-testonly123")) : undefined;
    await service.send(thread.id, "Start safely"); await settle();
    expect(rpc.stopped).toBe(1);
    expect(store.get(thread.id)).toMatchObject({ status: "interrupted", error: "权限配置未生效 [已隐藏]" });
    expect(new AgentStore(directory).get(thread.id).error).toBe("权限配置未生效 [已隐藏]");
  });

  it("keeps the execution slot reserved until native disconnect confirms a failed start has stopped", async () => {
    const { service, rpc, thread, store } = fixture();
    rpc.stop = () => { rpc.stopped++; };
    rpc.handler = method => method === "turn/start" ? Promise.reject(new Error("timeout")) : undefined;
    await service.send(thread.id, "Uncertain start"); await settle();
    expect(store.get(thread.id).status).toBe("running");
    await expect(service.send(thread.id, "Cannot overlap")).rejects.toMatchObject({ status: 409 });
    rpc.emit("disconnect", {});
    expect(store.get(thread.id).status).toBe("interrupted");
  });

  it("contains a failed timeout interruption and stops the native process", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { service, rpc, thread, store } = fixture();
    service.settings({ dailyTurnLimit: 30, dailyTokenBudget: 0, maxTaskMinutes: 1 });
    rpc.handler = method => method === "turn/interrupt" ? Promise.reject(new Error("disconnecting")) : undefined;
    await service.send(thread.id, "Long-running task"); await settle();
    await vi.advanceTimersByTimeAsync(60_001);
    expect(rpc.stopped).toBe(1);
    expect(store.get(thread.id).status).toBe("interrupted");
  });

  it("restores interrupted work without resuming it or exposing native IDs", async () => {
    const { directory, rpc, service, thread, store } = await running();
    rpc.request(10, "item/commandExecution/requestApproval", { threadId: "native-thread", turnId: activeTurn(store, thread.id), itemId: "command", command: "echo test" });
    expect(store.get(thread.id).status).toBe("waiting");
    const reopened = new AgentStore(directory);
    expect(reopened.get(thread.id)).toMatchObject({ status: "interrupted", approvals: [], activeTurnId: null });
    expect(reopened.get(thread.id).messages[0].text).toBe("Research this");
    expect(reopened.publicThread(reopened.get(thread.id))).not.toHaveProperty("nativeId");
    const nextRpc = new FakeRpc(), nextService = new AgentService(reopened, nextRpc, { workspace: directory, home: directory, executable: "unused-test-only" });
    await nextService.send(thread.id, "Resume safely"); await settle();
    expect(nextRpc.calls.some(call => call.method === "thread/resume")).toBe(true);
    expect(nextRpc.calls.some(call => call.method === "thread/start")).toBe(false);
    nextService.close(); service.close();
  });

  it("rejects stale approvals after disconnect and never grants unsupported permissions", async () => {
    const { service, rpc, thread, store } = await running();
    rpc.request(20, "item/commandExecution/requestApproval", { threadId: "native-thread", turnId: activeTurn(store, thread.id), itemId: "cmd", command: "echo test" });
    const approval = store.get(thread.id).approvals[0].id;
    rpc.request(21, "item/permissions/requestApproval", { threadId: "native-thread", permissions: { filesystem: { write: ["/"] } } });
    rpc.request(22, "mcpServer/elicitation/request", { threadId: "native-thread" });
    rpc.request(23, "unknown/privileged", { threadId: "native-thread" });
    expect(rpc.responses).toContainEqual({ id: 21, result: { permissions: {}, scope: "turn" } });
    expect(rpc.responses).toContainEqual({ id: 22, result: { action: "decline", content: null } });
    expect(rpc.responses.find(response => response.id === 23)?.result).not.toEqual({ decision: "accept" });
    rpc.emit("disconnect", {});
    expect(store.get(thread.id)).toMatchObject({ status: "interrupted", approvals: [], activeTurnId: null, error: "Codex 进程断开，任务未自动重试。" });
    await expect(service.decide(thread.id, approval, { decision: "accept" })).rejects.toMatchObject({ status: 409 });
  });

  it("refuses a valid approval ID under the wrong local thread", async () => {
    const { service, rpc, thread, store } = await running();
    rpc.request(30, "item/fileChange/requestApproval", { threadId: "native-thread", turnId: activeTurn(store, thread.id), itemId: "file" });
    const other = service.create({});
    await expect(service.decide(other.id, store.get(thread.id).approvals[0].id, { decision: "accept" })).rejects.toMatchObject({ status: 409 });
    expect(rpc.responses).toEqual([]);
  });

  it("counts observed cumulative usage once without blocking later work at removed daily limits", async () => {
    const { service, rpc, thread, store } = await running();
    const usage = { threadId: "native-thread", tokenUsage: { total: { inputTokens: 100, outputTokens: 20 } } };
    rpc.notification("thread/tokenUsage/updated", usage);
    rpc.notification("thread/tokenUsage/updated", usage);
    expect(store.usage()).toMatchObject({ turns: 1, inputTokens: 100, outputTokens: 20 });
    rpc.notification("turn/completed", { threadId: "native-thread", turn: { id: activeTurn(store, thread.id), status: "completed" } });
    service.settings({ dailyTurnLimit: 1, dailyTokenBudget: 0, maxTaskMinutes: 15 });
    expect(store.settings).toMatchObject({ dailyTurnLimit: 0, dailyTokenBudget: 0 });
    await expect(service.send(thread.id, "Excess turn")).resolves.toMatchObject({ id: thread.id, status: "running" });
  });

  it("does not count replayed cumulative totals twice after a lower usage notification", async () => {
    const { rpc, store } = await running();
    for (const inputTokens of [100, 80, 100]) rpc.notification("thread/tokenUsage/updated", { threadId: "native-thread", tokenUsage: { total: { inputTokens, outputTokens: 0 } } });
    expect(store.usage().inputTokens).toBe(100);
  });

  it("preserves unknown account quota without claiming zero usage", async () => {
    const { service, rpc } = fixture();
    rpc.handler = method => method === "account/rateLimits/read" ? { rateLimits: { primary: { usedPercent: null, windowDurationMins: null, resetsAt: null } } } : undefined;
    const status = await service.status();
    expect(status.quota.windows).toEqual([]);
    expect(status.quota.error).toBeTruthy();
    expect(status.authenticated).toBe(true);
  });

  it("attributes a turn to the actual start day when account refresh crosses midnight", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-04T15:59:59Z"));
    const { service, rpc, thread, store } = fixture();
    const account = deferred<Params>();
    rpc.handler = method => method === "account/read" ? account.promise : undefined;
    const pending = service.send(thread.id, "Across midnight"); await settle();
    vi.setSystemTime(new Date("2026-10-04T16:00:01Z"));
    account.resolve({ account: { type: "chatgpt" } }); await pending; await settle();
    expect(store.usage("2026-10-04").turns).toBe(0);
    expect(store.usage("2026-10-05").turns).toBe(1);
    rpc.notification("thread/tokenUsage/updated", { threadId: "native-thread", turnId: activeTurn(store, thread.id), tokenUsage: { total: { inputTokens: 50, outputTokens: 5 } } });
    expect(store.usage("2026-10-05").inputTokens).toBe(50);
  });

  it("bounds long public histories below the gateway limit with explicit truncation", async () => {
    const { service, rpc, thread, store } = await running();
    const turnId = activeTurn(store, thread.id);
    for (let index = 0; index < 220; index++) {
      rpc.notification("item/completed", { threadId: "native-thread", turnId, item: { id: `answer-${index}`, type: "agentMessage", text: "汉".repeat(30_000) } });
      rpc.notification("item/completed", { threadId: "native-thread", turnId, item: { id: `cmd-${index}`, type: "commandExecution", command: "echo test", aggregatedOutput: "\0".repeat(20_000) } });
    }
    for (let index = 0; index < 30; index++) rpc.request(100 + index, "item/commandExecution/requestApproval", { threadId: "native-thread", turnId, itemId: `approval-${index}`, command: "x".repeat(7000) });
    const view = store.publicThread(store.get(thread.id));
    expect(Buffer.byteLength(JSON.stringify(view))).toBeLessThan(1.5 * 1024 * 1024);
    expect(view.messages.some(message => message.text.includes("截断"))).toBe(true);
    expect(view.messages.some(message => message.id === "answer-219")).toBe(true);
    expect(view.approvals.length).toBeLessThanOrEqual(10);
    await service.interrupt(thread.id);
    await expect(service.send(thread.id, "History stays usable")).resolves.toBeDefined(); await settle();
  });
});
