import { TelegramClient, TelegramError } from "./client";
import { subscribed, TelegramStore } from "./store";

/** 每次发送一个可执行的投递，某个群重试不会挡住其余群。 */
export async function deliverTelegram(store: TelegramStore, api: TelegramClient, now = Date.now()): Promise<boolean> {
  if ((store.state.nextApiAt ?? 0) > now) return false;
  for (const job of store.jobs.values()) for (const d of job.deliveries) {
    if (d.state !== "pending") continue;
    const group = store.state.groups[d.chatId];
    if ((!job.direct && (!group || !subscribed(group) || d.messageThreadId !== group.messageThreadId)) || now - job.createdAt > 24 * 3600_000) {
      d.state = "skipped"; store.saveJob(job); continue;
    }
    if (d.nextAt > now || (group?.nextSendAt ?? 0) > now) continue;
    d.attempts++;
    d.nextAt = now + 3100;
    if (group) { group.nextSendAt = now + 3100; store.saveState(); }
    store.saveJob(job);
    try {
      const result = job.png || job.fileId
        ? await api.sendPhoto(d.chatId, job.content, job.png ?? "", job.fileId, d.messageThreadId)
        : await api.call<{ message_id: number; photo?: Array<{ file_id: string }> }>("sendMessage", {
          chat_id: d.chatId, text: job.content, ...(d.messageThreadId === undefined ? {} : { message_thread_id: d.messageThreadId }),
        });
      d.state = "sent"; d.messageId = result.message_id; delete d.error;
      job.fileId = result.photo?.at(-1)?.file_id ?? job.fileId;
    } catch (error) {
      const e = error instanceof TelegramError ? error : new TelegramError(0);
      d.error = e.code;
      if (e.migrateTo) store.migrate(d.chatId, String(e.migrateTo));
      else if (e.code === 403) {
        d.state = "skipped";
        if (group) { group.writable = false; store.saveState(); store.cancelGroup(group.id); }
      } else if (e.code === 400 && job.fileId && job.png) {
        delete job.fileId; // 缓存的 file_id 不可用时重传原图。
      } else if (e.code === 400) d.state = "failed";
      else if (e.code === 429) {
        d.nextAt = now + Math.max(1, e.retryAfter) * 1000;
        store.state.nextApiAt = d.nextAt;
        store.saveState();
        if (group) { group.nextSendAt = d.nextAt; store.saveState(); }
      } else d.nextAt = now + Math.min(300_000, 1000 * 2 ** Math.min(d.attempts, 9));
    }
    store.saveJob(job);
    return true;
  }
  return false;
}
