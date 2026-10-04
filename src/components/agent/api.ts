export class AgentApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export async function agentRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api/agent${path}`, {
    ...init,
    credentials: "same-origin",
    cache: "no-store",
    signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
    // Some embedded/local browser contexts omit Origin on same-origin POSTs.
    // This explicit header is sent only by our own client and lets the gateway
    // distinguish a browser request without relying on a browser-specific
    // Origin implementation.
    headers: { "Content-Type": "application/json", "X-Site-Agent-Request": "1", ...init.headers },
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    throw new AgentApiError(
      typeof data?.error === "string" ? data.error : `请求失败（${response.status}），请稍后重试。`,
      response.status,
    );
  }
  if (data === null) throw new Error("服务没有返回有效数据，请稍后重试。");
  return data as T;
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error && error.name === "TimeoutError") return "请求超时，请检查连接后重试。";
  return error instanceof Error ? error.message : "请求失败，请稍后重试。";
}

export function formatCount(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? value.toLocaleString("zh-CN") : "未知";
}

export function formatTime(value: string | number): string {
  const date = new Date(typeof value === "number" ? value * 1000 : value);
  return Number.isNaN(date.getTime()) ? "时间未知" : date.toLocaleString("zh-CN", {
    month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
  });
}
