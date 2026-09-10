export class TelegramError extends Error {
  constructor(public code: number, public retryAfter = 0, public migrateTo?: number) {
    // 不携带请求 URL、Token 或第三方响应正文进入日志。
    super(`Telegram API error ${code}`);
  }
}

export class TelegramClient {
  constructor(private token: string) {}

  async call<T>(method: string, body: Record<string, unknown> | FormData = {}): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`https://api.telegram.org/bot${this.token}/${method}`, {
        method: "POST",
        ...(body instanceof FormData ? { body } : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(method === "getUpdates" ? 40_000 : 25_000),
      });
    } catch { throw new TelegramError(0); }
    const result = await response.json().catch(() => null) as {
      ok: boolean; result: T; error_code?: number; parameters?: { retry_after?: number; migrate_to_chat_id?: number };
    } | null;
    if (!response.ok || !result?.ok) {
      throw new TelegramError(result?.error_code ?? response.status, result?.parameters?.retry_after, result?.parameters?.migrate_to_chat_id);
    }
    return result.result;
  }

  sendPhoto(chatId: string, caption: string, png: string, fileId?: string) {
    const body = new FormData();
    body.set("chat_id", chatId);
    body.set("caption", caption);
    if (fileId) body.set("photo", fileId);
    else body.set("photo", new Blob([new Uint8Array(Buffer.from(png, "base64"))], { type: "image/png" }), "signal.png");
    return this.call<{ message_id: number; photo?: Array<{ file_id: string }> }>("sendPhoto", body);
  }
}
