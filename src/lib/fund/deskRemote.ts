import { marketBaseUrl } from "@/lib/backtest/marketStore";

export function deskRemoteUrl(file: string): string | null {
  const base = marketBaseUrl();
  return base ? `${base}/desk/${file}` : null;
}

export function computeLiveBooksUrl(): string | null {
  const base = marketBaseUrl();
  return base ? `${base}/compute/live-books` : null;
}

function deskSecret(): string {
  return (process.env.DESK_STORE_SECRET || process.env.CRON_SECRET || "").trim();
}

async function fetchDesk(file: string, init?: RequestInit): Promise<Response> {
  const url = deskRemoteUrl(file);
  if (!url) throw new Error("VPS 地址未设");
  const headers = new Headers(init?.headers);
  const secret = deskSecret();
  if (secret && !headers.has("authorization")) {
    headers.set("authorization", `Bearer ${secret}`);
  }
  const res = await fetch(url, { cache: "no-store", ...init, headers });
  if (res.status === 404) {
    throw new Error("VPS 还没有 desk 存储，把这版推到 GitHub 才会重装行情服务");
  }
  return res;
}

export async function readDeskJson(file: string): Promise<unknown> {
  const res = await fetchDesk(file);
  if (!res.ok) throw new Error(`VPS 读取失败 HTTP ${res.status}`);
  const text = await res.text();
  if (!text.trim()) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`VPS ${file} 内容无效`);
  }
}

export async function postComputeLiveBooks(): Promise<unknown> {
  const url = computeLiveBooksUrl();
  if (!url) throw new Error("VPS 地址未设");
  const headers = new Headers();
  const secret = deskSecret();
  if (secret) headers.set("authorization", `Bearer ${secret}`);
  const res = await fetch(url, { method: "POST", cache: "no-store", headers });
  const json = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(json.error ?? `VPS 算账本失败 HTTP ${res.status}`);
  return json;
}

export async function writeDeskJson(file: string, value: unknown, expectedUpdatedAt?: string): Promise<void> {
  const res = await fetchDesk(file, {
    method: "PUT",
    headers: { "content-type": "application/json", ...(expectedUpdatedAt != null ? { "if-match": JSON.stringify(expectedUpdatedAt) } : {}) },
    body: `${JSON.stringify(value, null, 2)}\n`,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(text.trim() || `VPS 写入失败 HTTP ${res.status}`);
  }
}
