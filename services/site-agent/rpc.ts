import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { StringDecoder } from "node:string_decoder";

export type RpcMessage = { id?: string | number; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { message?: string } };
export interface AgentRpc {
  ensure(): Promise<void>;
  call<T = Record<string, unknown>>(method: string, params?: Record<string, unknown>): Promise<T>;
  respond(id: string | number, result: unknown): void;
  on(event: "notification" | "request" | "disconnect", listener: (message: RpcMessage) => void): this;
  stop(): void;
}
export class CodexRpc extends EventEmitter implements AgentRpc {
  private child: ChildProcessWithoutNullStreams | null = null;
  private starting: Promise<void> | null = null;
  private stopping: Promise<void> | null = null;
  private serial = 0;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  constructor(private options: { executable: string; cwd: string; home: string; timeoutMs?: number }) { super(); }
  ensure(): Promise<void> {
    if (this.stopping) return this.stopping.then(() => this.ensure());
    if (this.starting) return this.starting;
    if (this.child) return Promise.resolve();
    this.starting = this.start().finally(() => { this.starting = null; });
    return this.starting;
  }
  private async start() {
    // The model's subprocess must not inherit the web gateway, sender or deployment secrets.
    const env = { NODE_ENV: process.env.NODE_ENV, PATH: process.env.PATH, HOME: process.env.HOME, LANG: "C.UTF-8", TERM: "dumb", NO_COLOR: "1",
      CODEX_HOME: this.options.home };
    const child = spawn(this.options.executable, ["app-server", "--listen", "stdio://"], { cwd: this.options.cwd, env, stdio: "pipe", detached: true });
    this.child = child;
    let buffer = "", ended = false;
    const decoder = new StringDecoder("utf8");
    const end = () => {
      if (ended) return; ended = true;
      if (this.child === child) { this.stop(); this.child = null; }
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error("Codex 运行进程已断开")); }
      this.pending.clear(); this.emit("disconnect", {});
    };
    child.on("error", end); child.on("exit", end);
    child.stderr.on("data", () => { /* Native stderr may include private paths or provider details. */ });
    child.stdout.on("data", (chunk: Buffer) => {
      buffer += decoder.write(chunk);
      if (Buffer.byteLength(buffer) > 8_000_000) { this.stop(); return; }
      let boundary;
      while ((boundary = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 1);
        let m: RpcMessage;
        try { m = JSON.parse(line); } catch { continue; }
        if (m.method) this.emit(m.id == null ? "notification" : "request", m);
        else if (typeof m.id === "number") {
          const pending = this.pending.get(m.id);
          if (!pending) continue;
          clearTimeout(pending.timer); this.pending.delete(m.id);
          if (m.error) pending.reject(new Error(safeError(m.error.message ?? "Codex 请求失败")));
          else pending.resolve(m.result);
        }
      }
    });
    try { await this.call("initialize", { clientInfo: { name: "trend_adaptive_workbench", title: "Trend Adaptive Workbench", version: "1.0.0" }, capabilities: { experimentalApi: true } }); }
    catch (error) { this.stop(); throw error; }
    child.stdin.write(JSON.stringify({ method: "initialized", params: {} }) + "\n");
  }
  call<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (!this.child || this.child.killed) return Promise.reject(new Error("Codex 尚未启动"));
    const child = this.child, id = ++this.serial;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error("Codex 请求超时，请检查服务状态")); }, this.options.timeoutMs ?? 25_000);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      child.stdin.write(JSON.stringify({ id, method, params }) + "\n", error => {
        if (error) { clearTimeout(timer); this.pending.delete(id); reject(new Error("Codex 连接不可用")); }
      });
    });
  }
  respond(id: string | number, result: unknown) {
    this.child?.stdin.write(JSON.stringify({ id, result }) + "\n");
  }
  stop() {
    const child = this.child;
    if (!child || this.stopping) return;
    let done!: () => void;
    this.stopping = new Promise<void>(resolve => { done = resolve; });
    const signal = (value: NodeJS.Signals) => {
      try { if (child.pid) process.kill(-child.pid, value); } catch { child.kill(value); }
    };
    // Keep the grace period even when the parent exits: a command descendant
    // can still be alive in this process group after its parent has stopped.
    setTimeout(() => { signal("SIGKILL"); this.stopping = null; done(); }, 2000);
    signal("SIGTERM");
  }
  async shutdown() { this.stop(); await this.stopping; }
}
export function safeError(message: string): string {
  return message.replace(/\b(?:sk-[A-Za-z0-9_-]+|Bearer\s+\S+|eyJ[A-Za-z0-9_.-]{20,})/gi, "[已隐藏]")
    .replace(/https?:\/\/[^\s]+(?:token|key|secret)[^\s]*/gi, "[私有链接]").slice(0, 500);
}
