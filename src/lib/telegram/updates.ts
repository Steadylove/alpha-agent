import { createHash } from "node:crypto";
import { TelegramClient } from "./client";
import { subscribed, TelegramStore } from "./store";

type Chat = { id: number; type: string; title?: string; is_forum?: boolean };
type Member = { status: string; is_member?: boolean; can_send_messages?: boolean; can_send_photos?: boolean; can_post_messages?: boolean };
export type TelegramUpdate = {
  update_id: number;
  my_chat_member?: { chat: Chat; date: number; new_chat_member: Member; old_chat_member: Member };
  message?: {
    chat: Chat; date: number; text?: string; from?: { id: number; is_bot?: boolean }; sender_chat?: { id: number };
    migrate_to_chat_id?: number; migrate_from_chat_id?: number;
    message_thread_id?: number; is_topic_message?: boolean;
  };
};
const isGroup = (chat: Chat) => chat.type === "group" || chat.type === "supergroup";
const present = (m: Member) => ["member", "administrator", "creator"].includes(m.status) || (m.status === "restricted" && m.is_member === true);
const writable = (m: Member) => present(m) && (m.status !== "restricted" || (m.can_send_messages === true && m.can_send_photos === true));
const hash = (s: string) => createHash("sha256").update(s).digest("hex");

export async function processTelegramUpdate(store: TelegramStore, api: TelegramClient, bot: { id: number; username: string }, update: TelegramUpdate) {
  if (!Number.isSafeInteger(update.update_id) || update.update_id < store.state.offset) return;
  const member = update.my_chat_member;
  if (member && isGroup(member.chat)) {
    const id = String(member.chat.id), old = store.state.groups[id];
    if (!old?.migratedTo && (!old || member.date >= old.updatedAt)) {
      const joined = present(member.new_chat_member) && !present(member.old_chat_member);
      store.state.groups[id] = { ...old, id, title: member.chat.title ?? "", present: present(member.new_chat_member), writable: writable(member.new_chat_member),
        paused: joined && !old?.migratedFrom ? false : old?.paused ?? false, updatedAt: member.date, nextSendAt: old?.nextSendAt ?? 0,
        needsTopic: old?.needsTopic ?? (member.chat.is_forum === true && old?.messageThreadId === undefined) };
      store.saveState();
      if (!subscribed(store.state.groups[id])) store.cancelGroup(id);
      if (joined && store.state.groups[id].writable) store.enqueue(hash(`welcome:${update.update_id}`), store.state.groups[id].needsTopic
        ? `请群管理员进入接收信号的话题，发送 /resume@${bot.username}，即可将之后的信号推送到该话题。`
        : "已开启信号推送：买卖信号、4H/2H 账本和 GEX。群管理员可用 /pause 暂停、/resume 恢复，/status 查看状态。",
      undefined, id, undefined, store.state.groups[id].messageThreadId);
    }
  }
  const m = update.message;
  if (m && isGroup(m.chat)) {
    if (m.migrate_to_chat_id) store.migrate(String(m.chat.id), String(m.migrate_to_chat_id));
    if (m.migrate_from_chat_id) store.migrate(String(m.migrate_from_chat_id), String(m.chat.id));
    const match = /^\/(start|help|status|pause|resume)(?:@([A-Za-z0-9_]+))?(?:\s|$)/.exec(m.text ?? "");
    if (match && (!match[2] || match[2].toLowerCase() === bot.username.toLowerCase())) {
      const id = String(m.chat.id), command = match[1];
      // General 不带话题路由；只使用 Telegram 标记为话题消息的有效 ID。
      const threadId = m.is_topic_message === true && Number.isSafeInteger(m.message_thread_id) && m.message_thread_id! > 0 ? m.message_thread_id : undefined;
      let text = `将机器人加入群并允许发送文字和图片。话题群请管理员在目标话题发送 /resume@${bot.username} 绑定推送位置。/pause 暂停，/status 查看状态。`;
      if (["pause", "resume", "start"].includes(command)) {
        // 匿名管理员以本群身份发言；普通用户必须经 Telegram 实时确认管理员身份。
        const anonymousAdmin = m.sender_chat?.id === m.chat.id;
        const admins = !anonymousAdmin && m.from && !m.from.is_bot && !m.sender_chat
          ? await api.call<Array<{ user: { id: number }; status: string }>>("getChatAdministrators", { chat_id: id }) : [];
        const admin = anonymousAdmin || admins.some((a) => a.user.id === m.from?.id && ["creator", "administrator"].includes(a.status));
        if (!admin) text = "只有本群管理员可以暂停或恢复信号推送。";
        else if (command === "pause") {
          if (store.state.groups[id]) { store.state.groups[id].paused = true; store.saveState(); store.cancelGroup(id); }
          text = "已暂停本群信号推送。管理员发送 /resume 可恢复。";
        } else if (command === "start" && m.chat.is_forum && threadId === undefined) {
          // 加群链接会自动在 General 发送 /start，不能据此覆盖管理员选好的话题。
          text = `请进入接收信号的话题，发送 /resume@${bot.username}。若要发到 General，请在 General 发送该命令。`;
        } else {
          const self = await api.call<Member>("getChatMember", { chat_id: id, user_id: bot.id });
          const old = store.state.groups[id];
          store.state.groups[id] = { ...old, id, title: m.chat.title ?? "", paused: false, present: present(self), writable: writable(self),
            updatedAt: m.date, nextSendAt: old?.nextSendAt ?? 0, messageThreadId: threadId, needsTopic: false };
          store.saveState();
          if (old?.messageThreadId !== threadId) store.cancelGroup(id);
          text = subscribed(store.state.groups[id])
            ? `已开启信号推送，之后的新信号将发送到${threadId !== undefined ? "当前话题" : m.chat.is_forum ? " General" : "本群"}。每个群只绑定一个接收位置。`
            : "请允许机器人在本群发送文字和图片，然后在目标位置发送 /resume。";
        }
      } else if (command === "status") {
        const group = store.state.groups[id];
        text = !group?.present ? "本群尚未订阅，请管理员发送 /resume。" : group.paused ? "本群推送已暂停。" : !group.writable ? "机器人缺少发送权限，请管理员允许发送文字和图片。"
          : group.needsTopic ? `请群管理员在接收信号的话题发送 /resume@${bot.username}。`
          : `本群推送已开启：买卖信号、4H/2H 账本和 GEX。接收位置：${group.messageThreadId !== undefined ? group.messageThreadId === threadId ? "当前话题" : `话题 #${group.messageThreadId}` : m.chat.is_forum ? "General" : "本群"}。`;
      }
      store.enqueue(hash(`command:${update.update_id}`), text, undefined, id, undefined, threadId);
    }
  } else if (m?.chat.type === "private" && /^\/(start|help)(?:\s|$)/.test(m.text ?? "")) {
    store.enqueue(hash(`help:${update.update_id}`), `将 @${bot.username} 加入群并允许发送文字和图片。普通群自动订阅；话题群请管理员在目标话题发送 /resume@${bot.username}。接收买卖信号、每日账本和 GEX，/pause 暂停，/status 查看状态。`, undefined, String(m.chat.id));
  }
  store.state.offset = update.update_id + 1;
  store.saveState();
}
