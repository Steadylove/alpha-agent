import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { AgentApprovalDecision, AgentCreateThread, AgentModel, AgentSettings, AgentStatus, AgentThreadPatch } from "../../src/lib/siteAgent/types";
import { AgentStore, settingsSchema, withoutDailyLimits, type StoredThread } from "./store";
import { safeError, type AgentRpc, type RpcMessage } from "./rpc";
import { sitePermissions, verifySitePermissions } from "./permissions";

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => v && typeof v === "object" && !Array.isArray(v) ? v as Json : {};
const str = (v: unknown, limit = 12000) => typeof v === "string" ? v.slice(0, limit) : "";
const num = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0;
const PREFERRED_MODEL = "gpt-6.1-sol";
export class AgentError extends Error { constructor(message: string, public status = 400) { super(message); } }
export class AgentService {
  private loaded = new Set<string>();
  private timers = new Map<string, NodeJS.Timeout>();
  private approvals = new Map<string, { rpcId: string | number; method: string; threadId: string }>();
  private loginProcess: ChildProcessWithoutNullStreams | null = null;
  private loginTimer: NodeJS.Timeout | null = null;
  private loginCancelled = false;
  private closed = false;
  private loginState: AgentStatus["login"] = { status: "idle" };
  private account: AgentStatus["account"] = null;
  private models: AgentModel[] = [];
  private quota: AgentStatus["quota"] = { windows: [], error: "尚未读取额度", updatedAt: null };
  private accountCheckedAt = 0;
  private accountGeneration = 0;
  private accountRefresh: Promise<void> | null = null;
  private saveTimer: NodeJS.Timeout | null = null;
  private runDay = new Map<string, string>();
  private starts = new Map<string, Promise<void>>();
  private cancelling = new Set<string>();
  private generations = new Map<string, string>();
  private retiredTurns = new Map<string, Set<string>>();
  private turnDays = new Map<string, string>();
  private interruptions = new Map<string, Promise<ReturnType<AgentStore["publicThread"]>>>();
  constructor(readonly store: AgentStore, private rpc: AgentRpc, private options: { workspace: string; executable: string; home: string }) {
    rpc.on("notification", m => this.notification(m));
    rpc.on("request", m => this.request(m));
    rpc.on("disconnect", () => {
      this.loaded.clear(); this.accountCheckedAt = 0; this.accountGeneration++;
      for (const t of store.threads.values()) if (this.busy(t)) this.finish(t, "interrupted", t.error || "Codex 进程断开，任务未自动重试。");
    });
  }
  private busy(t: StoredThread) { return t.status === "running" || t.status === "waiting"; }
  private current(t: StoredThread, generation: string) { return this.generations.get(t.id) === generation && this.busy(t); }
  private rememberTurn(t: StoredThread) {
    this.turnDays.set(`${t.nativeId}:${t.activeTurnId}`, this.runDay.get(t.id) ?? this.store.day());
    while (this.turnDays.size > 4096) this.turnDays.delete(this.turnDays.keys().next().value!);
  }
  private active() { return [...this.store.threads.values()].filter(t => this.busy(t)); }
  private persist(immediate = false) {
    if (immediate) { if (this.saveTimer) clearTimeout(this.saveTimer); this.saveTimer = null; this.store.save(); return; }
    if (!this.saveTimer) this.saveTimer = setTimeout(() => { this.saveTimer = null; this.store.save(); }, 250);
  }
  private async refreshAccount(force = false) {
    if (!force && Date.now() - this.accountCheckedAt < 60_000) return;
    if (this.accountRefresh) return this.accountRefresh;
    this.accountRefresh = (async () => {
      await this.rpc.ensure();
      const generation = this.accountGeneration;
      const accountResult = await this.rpc.call("account/read", { refreshToken: false });
      if (generation !== this.accountGeneration) return;
      const account = obj(accountResult.account);
      this.account = typeof account.type === "string" ? { type: account.type, plan: str(account.planType, 80) || null } : null;
      const [models, limits] = await Promise.allSettled([
        this.rpc.call("model/list", { includeHidden: false }),
        this.account ? this.rpc.call("account/rateLimits/read") : Promise.reject(new Error("请先授权 Codex 账号")),
      ]);
      if (generation !== this.accountGeneration) return;
      if (models.status === "fulfilled") this.models = (Array.isArray(models.value.data) ? models.value.data : []).map(raw => {
        const m = obj(raw), efforts = Array.isArray(m.supportedReasoningEfforts) ? m.supportedReasoningEfforts : [];
        return { id: str(m.model || m.id, 120), name: str(m.displayName || m.model || m.id, 120),
          efforts: efforts.map(x => str(obj(x).reasoningEffort, 20)).filter(Boolean),
          defaultEffort: str(m.defaultReasoningEffort, 20) || "medium", isDefault: m.isDefault === true };
      }).filter(m => m.id).slice(0, 50);
      if (limits.status === "fulfilled") {
        const source = limits.value, buckets = obj(source.rateLimitsByLimitId);
        const values = Object.keys(buckets).length ? Object.values(buckets) : [source.rateLimits];
        const windows: AgentStatus["quota"]["windows"] = [];
        for (const raw of values) {
          const bucket = obj(raw);
          for (const key of ["primary", "secondary"]) {
            const w = obj(bucket[key]);
            if (typeof w.usedPercent !== "number" || typeof w.windowDurationMins !== "number" || typeof w.resetsAt !== "number") continue;
            windows.push({ name: `${str(bucket.limitName || bucket.limitId, 80) || "Codex"} · ${key === "primary" ? "主要窗口" : "第二窗口"}`,
              usedPercent: Math.min(100, Math.max(0, w.usedPercent)), windowMinutes: w.windowDurationMins, resetsAt: w.resetsAt });
          }
        }
        this.quota = { windows, error: windows.length ? null : "该账号暂未返回可用的额度窗口", updatedAt: new Date().toISOString() };
      } else this.quota = { windows: [], error: this.account ? "暂时无法读取订阅额度；不会将未知额度视为零。" : "请先授权 Codex 账号", updatedAt: null };
      this.accountCheckedAt = Date.now();
    })().finally(() => { this.accountRefresh = null; });
    return this.accountRefresh;
  }
  async status(): Promise<AgentStatus> {
    let error: string | null = null, available = true;
    try { await this.refreshAccount(); } catch (e) { available = false; error = safeError(e instanceof Error ? e.message : "Codex 连接失败"); }
    return { available, authenticated: !!this.account && available, account: this.account, models: this.models, quota: this.quota,
      settings: { ...this.store.settings }, usage: { date: this.store.day(), ...this.store.usage(), activeTasks: this.active().length },
      login: { ...this.loginState }, error };
  }
  create(input: AgentCreateThread) {
    if (this.store.threads.size >= 500) throw new AgentError("会话数量已达 500，请先由管理员整理归档", 409);
    const model = input.model || this.models.find(m => m.id === PREFERRED_MODEL)?.id || this.models.find(m => m.isDefault)?.id || "";
    if (model && this.models.length && !this.models.some(m => m.id === model)) throw new AgentError("请选择可用模型");
    const now = new Date().toISOString(), t: StoredThread = { id: randomUUID(), title: input.title?.trim() || "新会话", createdAt: now,
      updatedAt: now, status: "idle", model, effort: input.effort || this.models.find(m => m.id === model)?.defaultEffort || "medium",
      // The public workbench is intentionally read-only. Keep the mode in the
      // stored contract for compatibility with older conversations, but every
      // new thread uses the research permission profile.
      mode: "research", archived: false, inputTokens: 0, outputTokens: 0, messages: [], activities: [], approvals: [], error: null,
      nativeId: null, activeTurnId: null, nativeInputTokens: 0, nativeOutputTokens: 0 };
    this.store.threads.set(t.id, t); this.persist(true); return this.store.publicThread(t);
  }
  patch(id: string, patch: AgentThreadPatch) {
    const t = this.store.get(id);
    if (patch.archived != null && this.busy(t)) throw new AgentError("请先停止任务，再归档会话", 409);
    if (patch.title != null) t.title = patch.title.trim();
    if (patch.archived != null) t.archived = patch.archived;
    t.updatedAt = new Date().toISOString(); this.persist(true); return this.store.publicThread(t);
  }
  settings(settings: AgentSettings) {
    this.store.settings = withoutDailyLimits(settingsSchema.parse(settings)); this.persist(true); return { ...this.store.settings };
  }
  async send(id: string, text: string) {
    const t = this.store.get(id);
    if (t.archived) throw new AgentError("请先恢复归档会话", 409);
    if (t.mode !== "research") throw new AgentError("工作台当前只提供只读研究模式，请新建只读对话", 409);
    if (this.active().length) throw new AgentError("已有任务正在执行或等待确认，请完成或取消后再发送", 409);
    if (this.loginState.status === "pending") throw new AgentError("请先完成账号授权", 409);
    const settings = this.store.settings;
    // Reserve the worker before awaiting IO, preventing two browser requests starting together.
    t.status = "running"; t.error = null; t.activities = []; t.approvals = []; t.activeTurnId = null;
    const generation = randomUUID(); this.generations.set(id, generation);
    this.persist(true);
    try {
      await this.refreshAccount(true);
      if (!this.current(t, generation)) return this.store.publicThread(t);
      if (!this.account) throw new AgentError("请先登录 Codex 账号", 409);
      const at = new Date().toISOString();
      if (t.messages.length === 0 && t.title === "新会话") t.title = text.trim().replace(/\s+/g, " ").slice(0, 35);
      t.messages.push({ id: randomUUID(), role: "user", text, createdAt: at }); t.updatedAt = at;
      this.runDay.set(id, this.store.day()); this.store.usage(this.runDay.get(id)).turns += 1; this.persist(true);
      this.timers.set(id, setTimeout(() => {
        if (this.current(t, generation)) void this.interrupt(id, "任务达到工作台时长上限，已请求停止。").catch(() => {});
      }, settings.maxTaskMinutes * 60_000));
      const start = this.run(t, text, generation).catch(e => {
        if (!this.current(t, generation)) return;
        // A timed-out start can already be executing. Keep the slot reserved
        // until disconnect confirms that the native process has stopped.
        t.error = safeError(e instanceof Error ? e.message : "任务启动失败"); this.persist(true); this.rpc.stop();
      }).finally(() => { if (this.starts.get(id) === start) this.starts.delete(id); });
      this.starts.set(id, start);
      return this.store.publicThread(t);
    } catch (e) { this.finish(t, "failed", safeError(e instanceof Error ? e.message : "任务启动失败"), generation); throw e; }
  }
  private async run(t: StoredThread, text: string, generation: string) {
    await this.rpc.ensure();
    if (!this.current(t, generation)) return;
    const permissions = sitePermissions(t.mode, this.options.home);
    // Do not send legacy `sandbox`: it would replace the profile's denied read paths.
    const config = { cwd: this.options.workspace, approvalPolicy: permissions.approvalPolicy, config: permissions.config,
      ...(t.model ? { model: t.model } : {}) };
    if (!t.nativeId) {
      const result = await this.rpc.call("thread/start", config), native = obj(result.thread);
      if (!this.current(t, generation)) return;
      verifySitePermissions(result, permissions.id);
      if (typeof native.id !== "string") throw new Error("Codex 未返回会话 ID");
      t.nativeId = native.id; this.loaded.add(t.id); this.persist(true);
    } else if (!this.loaded.has(t.id)) {
      const result = await this.rpc.call("thread/resume", { ...config, threadId: t.nativeId });
      if (!this.current(t, generation)) return;
      verifySitePermissions(result, permissions.id);
      this.loaded.add(t.id);
    }
    if (!this.current(t, generation) || this.cancelling.has(t.id)) return;
    const result = await this.rpc.call("turn/start", { threadId: t.nativeId, input: [{ type: "text", text }], effort: t.effort });
    if (this.current(t, generation)) {
      t.activeTurnId = str(obj(result.turn).id, 160) || t.activeTurnId;
      if (!t.activeTurnId) throw new Error("Codex 未返回任务 ID");
      this.rememberTurn(t); this.persist(true);
    }
  }
  async interrupt(id: string, reason = "任务已由你停止。") {
    const t = this.store.get(id);
    if (!this.busy(t)) return this.store.publicThread(t);
    const generation = this.generations.get(id)!;
    const existing = this.interruptions.get(generation); if (existing) return existing;
    const pending = this.interruptRun(t, generation, reason).finally(() => this.interruptions.delete(generation));
    this.interruptions.set(generation, pending); return pending;
  }
  private async interruptRun(t: StoredThread, generation: string, reason: string) {
    const id = t.id;
    this.cancelling.add(id);
    await this.starts.get(id);
    if (!this.current(t, generation)) return this.store.publicThread(t);
    if (t.nativeId && t.activeTurnId) {
      try { await this.rpc.call("turn/interrupt", { threadId: t.nativeId, turnId: t.activeTurnId }); }
      catch {
        if (this.current(t, generation)) { t.error = "停止请求未得到确认，正在终止运行进程。"; this.persist(true); this.rpc.stop(); }
        throw new AgentError("停止请求未得到确认，正在终止运行进程", 502);
      }
    }
    this.finish(t, "interrupted", reason, generation); return this.store.publicThread(t);
  }
  async decide(id: string, approvalId: string, input: AgentApprovalDecision) {
    const t = this.store.get(id), pending = this.approvals.get(approvalId);
    if (!pending || pending.threadId !== id || this.cancelling.has(id) || !t.approvals.some(a => a.id === approvalId)) throw new AgentError("确认项已失效，请刷新", 409);
    if (pending.method === "item/tool/requestUserInput") {
      const answers: Record<string, { answers: string[] }> = {};
      const request = t.approvals.find(a => a.id === approvalId)!;
      if (input.decision === "accept") for (const q of request.questions ?? []) answers[q.id] = { answers: input.answers?.[q.id] ?? [] };
      this.rpc.respond(pending.rpcId, { answers });
    } else this.rpc.respond(pending.rpcId, { decision: input.decision });
    this.approvals.delete(approvalId); t.approvals = t.approvals.filter(a => a.id !== approvalId);
    t.status = t.approvals.length ? "waiting" : "running"; this.persist(true); return this.store.publicThread(t);
  }
  private finish(t: StoredThread, status: StoredThread["status"], error: string | null, generation?: string) {
    if (generation && !this.current(t, generation)) return;
    const timer = this.timers.get(t.id); if (timer) clearTimeout(timer); this.timers.delete(t.id);
    this.cancelling.delete(t.id);
    if (t.activeTurnId) {
      const retired = this.retiredTurns.get(t.id) ?? new Set<string>(); retired.add(t.activeTurnId);
      while (retired.size > 256) retired.delete(retired.values().next().value!);
      this.retiredTurns.set(t.id, retired);
    }
    this.generations.delete(t.id);
    for (const a of t.approvals) { const p = this.approvals.get(a.id); if (p) this.rpc.respond(p.rpcId, p.method === "item/tool/requestUserInput" ? { answers: {} } : { decision: "cancel" }); this.approvals.delete(a.id); }
    t.status = status; t.error = error; t.activeTurnId = null; t.approvals = []; t.updatedAt = new Date().toISOString();
    this.accountCheckedAt = 0; this.persist(true);
  }
  private findNative(nativeId: unknown) { return [...this.store.threads.values()].find(t => t.nativeId && t.nativeId === nativeId); }
  private acceptsTurn(t: StoredThread, turnId: unknown) {
    if (typeof turnId !== "string" || !turnId) return true;
    return !this.retiredTurns.get(t.id)?.has(turnId) && (!t.activeTurnId || t.activeTurnId === turnId);
  }
  private request(message: RpcMessage) {
    const p = obj(message.params), t = this.findNative(p.threadId), method = message.method ?? "";
    if (message.id == null) return;
    if (!t || !this.busy(t) || this.cancelling.has(t.id) || !this.acceptsTurn(t, p.turnId) || !["item/commandExecution/requestApproval", "item/fileChange/requestApproval", "item/tool/requestUserInput"].includes(method)) {
      if (method === "item/permissions/requestApproval") this.rpc.respond(message.id, { permissions: {}, scope: "turn" });
      else if (method === "mcpServer/elicitation/request") this.rpc.respond(message.id, { action: "decline", content: null });
      else this.rpc.respond(message.id, method === "item/tool/requestUserInput" ? { answers: {} } : { decision: "decline" });
      return;
    }
    const id = randomUUID(), kind = method.includes("commandExecution") ? "command" : method.includes("fileChange") ? "file" : "question";
    const questions = kind === "question" && Array.isArray(p.questions) ? p.questions.slice(0, 5).map(raw => {
      const q = obj(raw); return { id: str(q.id, 100), header: str(q.header, 100), question: str(q.question, 4000),
        options: Array.isArray(q.options) ? q.options.slice(0, 10).map(rawOption => { const o = obj(rawOption); return { label: str(o.label, 300), description: str(o.description, 600) }; }) : undefined };
    }) : undefined;
    const changes = t.activities.find(a => a.id === p.itemId)?.detail;
    const approval: StoredThread["approvals"][number] = { id, kind, title: kind === "command" ? "允许执行这条命令？" : kind === "file" ? "允许这次文件修改？" : "Codex 需要补充信息",
      detail: [str(p.reason, 2000), str(p.command, 8000) || changes || str(p.grantRoot, 1000), str(p.cwd, 1000)].filter(Boolean).join("\n"), questions };
    if (t.approvals.length >= 10 || Buffer.byteLength(JSON.stringify([...t.approvals, approval])) > 220_000 || (typeof p.command === "string" && p.command.length > 8000)) {
      this.rpc.respond(message.id, kind === "question" ? { answers: {} } : { decision: "decline" }); return;
    }
    this.approvals.set(id, { rpcId: message.id, method, threadId: t.id }); t.approvals.push(approval);
    t.status = "waiting"; this.persist(true);
  }
  private notification(message: RpcMessage) {
    const p = obj(message.params), t = this.findNative(p.threadId);
    if (message.method === "account/rateLimits/updated" || message.method === "account/updated") { this.accountCheckedAt = 0; return; }
    if (!t) return;
    if (message.method === "thread/tokenUsage/updated") {
      const total = obj(obj(p.tokenUsage).total), input = num(total.inputTokens), output = num(total.outputTokens);
      const di = Math.max(0, input - t.nativeInputTokens), dout = Math.max(0, output - t.nativeOutputTokens);
      t.nativeInputTokens = Math.max(input, t.nativeInputTokens); t.nativeOutputTokens = Math.max(output, t.nativeOutputTokens); t.inputTokens += di; t.outputTokens += dout;
      const day = this.store.usage(this.turnDays.get(`${t.nativeId}:${p.turnId}`) ?? this.runDay.get(t.id) ?? this.store.day()); day.inputTokens += di; day.outputTokens += dout;
      this.persist();
      return;
    }
    if (!this.busy(t)) return;
    if (!this.acceptsTurn(t, p.turnId ?? obj(p.turn).id)) return;
    switch (message.method) {
      case "turn/started": {
        t.activeTurnId = str(obj(p.turn).id, 160);
        this.rememberTurn(t); break;
      }
      case "turn/completed": {
        const turn = obj(p.turn); const state = turn.status;
        this.finish(t, state === "completed" ? "idle" : state === "interrupted" ? "interrupted" : "failed",
          state === "completed" ? null : safeError(str(obj(turn.error).message, 500) || (state === "interrupted" ? "任务已停止" : "Codex 任务失败"))); return;
      }
      case "item/agentMessage/delta": {
        const id = str(p.itemId, 160); if (!id) break;
        let m = t.messages.find(m => m.id === id);
        if (!m) { m = { id, role: "assistant", text: "", createdAt: new Date().toISOString() }; t.messages.push(m); }
        m.text = (m.text + str(p.delta, 40000)).slice(0, 120000); break;
      }
      case "item/started": case "item/completed": {
        const item = obj(p.item), type = str(item.type, 100), id = str(item.id, 160);
        if (type === "agentMessage") {
          const text = str(item.text, 120000); let m = t.messages.find(m => m.id === id);
          if (!m && text) { m = { id, role: "assistant", text, createdAt: new Date().toISOString() }; t.messages.push(m); }
          else if (m && text) m.text = text;
        } else if (["commandExecution", "fileChange", "webSearch", "mcpToolCall", "dynamicToolCall", "plan", "imageView", "collabAgentToolCall"].includes(type)) {
          let activity = t.activities.find(a => a.id === id);
          const title = type === "commandExecution" ? str(item.command, 200) : type === "fileChange" ? "修改工作区文件" : type === "webSearch" ? "搜索公开资料" : str(item.tool || item.prompt, 200) || type;
          const detail = type === "fileChange" ? JSON.stringify(item.changes ?? []).slice(0, 20000) : str(item.aggregatedOutput || item.query, 20000);
          if (!activity) { activity = { id, type, title, status: "inProgress" }; t.activities.push(activity); }
          activity.status = str(item.status, 80) || (message.method === "item/completed" ? "completed" : "inProgress");
          if (detail) activity.detail = detail;
          t.activities = t.activities.slice(-80);
        }
        break;
      }
      case "serverRequest/resolved": {
        for (const [id, request] of this.approvals) if (request.threadId === t.id && String(request.rpcId) === String(p.requestId)) {
          this.approvals.delete(id); t.approvals = t.approvals.filter(a => a.id !== id);
        }
        t.status = t.approvals.length ? "waiting" : "running"; break;
      }
      case "error": if (p.willRetry !== true) t.error = safeError(str(obj(p.error).message, 500) || "Codex 返回错误"); break;
      default: return; // Reasoning, raw tokens, internal metadata and arbitrary tool payloads are never published.
    }
    this.store.boundThread(t); t.updatedAt = new Date().toISOString(); this.persist();
  }
  startLogin() {
    if (this.closed) throw new AgentError("服务正在关闭，请稍后重试", 503);
    if (this.active().length) throw new AgentError("请先停止正在运行的任务", 409);
    if (this.loginProcess) return { ...this.loginState };
    this.loginState = { status: "pending" };
    this.loginCancelled = false;
    const child = spawn(this.options.executable, ["login", "--device-auth"], { cwd: this.options.workspace,
      env: { NODE_ENV: process.env.NODE_ENV, PATH: process.env.PATH, HOME: process.env.HOME, LANG: "C.UTF-8", TERM: "dumb", NO_COLOR: "1", CODEX_HOME: this.options.home }, stdio: "pipe" });
    this.loginProcess = child; let output = "";
    const current = () => this.loginProcess === child;
    const parse = (chunk: Buffer) => {
      if (!current() || this.loginCancelled || this.loginState.status !== "pending") return;
      output = (output + chunk.toString()).replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "").slice(-12000);
      const url = output.match(/https:\/\/(?:auth\.openai\.com|chatgpt\.com)\/[a-zA-Z0-9/_-]+/);
      const code = output.match(/\b[A-Z0-9]{4,5}-[A-Z0-9]{4,5}\b/);
      if (url) this.loginState.url = url[0]; if (code) this.loginState.code = code[0];
    };
    child.stdout.on("data", parse); child.stderr.on("data", parse);
    const timer = this.loginTimer = setTimeout(() => this.cancelLogin("授权等待已超时，请重新发起并使用新的设备码。"), 15 * 60_000);
    child.on("error", () => {
      if (!current()) return;
      clearTimeout(timer); this.loginTimer = null;
      if (!this.loginCancelled) this.loginState = { status: "failed", error: "无法启动 Codex 设备授权" };
      this.loginCancelled = true;
      if (!child.pid) this.loginProcess = null;
    });
    child.once("exit", code => {
      if (!current()) return;
      clearTimeout(timer); this.loginTimer = null;
      // The npm wrapper can exit zero after forwarding SIGTERM. Cancellation
      // remains a failure regardless of the wrapper's reported exit code.
      if (this.loginCancelled) { this.loginProcess = null; return; }
      if (code !== 0) {
        this.loginState = { status: "failed", error: "授权未完成或已过期，请重新发起。" };
        this.loginProcess = null; return;
      }
      const previousRefresh = this.accountRefresh;
      this.accountGeneration++; this.accountCheckedAt = 0; this.account = null;
      this.rpc.stop();
      // Retain the attempt while verifying, so a repeated POST cannot overlap it.
      void (async () => {
        try {
          await previousRefresh?.catch(() => {});
          if (!current() || this.loginCancelled) return;
          await this.refreshAccount(true);
          if (!current() || this.loginCancelled) return;
          this.loginState = this.account ? { status: "complete" } : { status: "failed", error: "未确认到已登录账号，请重新发起设备授权。" };
        } catch {
          if (current() && !this.loginCancelled) this.loginState = { status: "failed", error: "无法确认账号授权状态，请刷新后重试。" };
        } finally { if (current()) this.loginProcess = null; }
      })();
    });
    return { ...this.loginState };
  }
  private cancelLogin(error: string) {
    if (!this.loginProcess) return;
    this.loginCancelled = true; this.loginState = { status: "failed", error };
    if (this.loginTimer) clearTimeout(this.loginTimer);
    this.loginTimer = null; this.loginProcess.kill();
  }
  close() {
    this.closed = true; this.accountGeneration++;
    this.cancelLogin("服务已关闭，设备授权未完成，请重新发起。");
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.rpc.stop(); this.persist(true);
  }
}
