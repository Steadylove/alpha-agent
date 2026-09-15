import { createHash } from "node:crypto";
import { TelegramClient } from "./client";
import { bindTopic, displayTopicTitle, rememberTopicName, subscribed, TelegramStore, topicsOf } from "./store";

type Chat = { id: number; type: string; title?: string; is_forum?: boolean };
type Member = { status: string; is_member?: boolean; can_send_messages?: boolean; can_send_photos?: boolean; can_post_messages?: boolean };
type TopicName = { name?: string };
type Message = {
  chat: Chat; date: number; text?: string; from?: { id: number; is_bot?: boolean }; sender_chat?: { id: number };
  migrate_to_chat_id?: number; migrate_from_chat_id?: number;
  message_thread_id?: number; is_topic_message?: boolean;
  forum_topic_created?: TopicName; forum_topic_edited?: TopicName;
  reply_to_message?: { forum_topic_created?: TopicName; forum_topic_edited?: TopicName };
};
export type TelegramUpdate = {
  update_id: number;
  my_chat_member?: { chat: Chat; date: number; new_chat_member: Member; old_chat_member: Member };
  message?: Message;
};
const isGroup = (chat: Chat) => chat.type === "group" || chat.type === "supergroup";
const present = (m: Member) => ["member", "administrator", "creator"].includes(m.status) || (m.status === "restricted" && m.is_member === true);
const writable = (m: Member) => present(m) && (m.status !== "restricted" || (m.can_send_messages === true && m.can_send_photos === true));
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const commandThreadId = (m: Message) => m.is_topic_message === true && Number.isSafeInteger(m.message_thread_id) && m.message_thread_id! > 0 ? m.message_thread_id : undefined;
const nameThreadId = (m: Message) => {
  if (!Number.isSafeInteger(m.message_thread_id) || !m.message_thread_id || m.message_thread_id <= 0) return undefined;
  if (m.forum_topic_created || m.forum_topic_edited || m.is_topic_message === true) return m.message_thread_id;
};
export function topicNameOf(m: Pick<Message, "forum_topic_created" | "forum_topic_edited" | "reply_to_message">): string | undefined {
  const raw = m.forum_topic_created?.name ?? m.forum_topic_edited?.name
    ?? m.reply_to_message?.forum_topic_created?.name ?? m.reply_to_message?.forum_topic_edited?.name;
  const name = typeof raw === "string" ? raw.trim() : "";
  return name && name.length < 128 ? name : undefined;
}

export async function processTelegramUpdate(store: TelegramStore, api: TelegramClient, bot: { id: number; username: string }, update: TelegramUpdate) {
  if (!Number.isSafeInteger(update.update_id) || update.update_id < store.state.offset) return;
  const member = update.my_chat_member;
  if (member && isGroup(member.chat)) {
    const id = String(member.chat.id), old = store.state.groups[id];
    if (!old?.migratedTo && (!old || member.date >= old.updatedAt)) {
      const joined = present(member.new_chat_member) && !present(member.old_chat_member);
      store.state.groups[id] = { ...old, id, title: member.chat.title ?? "", present: present(member.new_chat_member), writable: writable(member.new_chat_member),
        paused: joined && !old?.migratedFrom ? false : old?.paused ?? false, updatedAt: member.date, nextSendAt: old?.nextSendAt ?? 0,
        needsTopic: old?.topics && Object.keys(old.topics).length ? false : old?.needsTopic ?? (member.chat.is_forum === true && old?.messageThreadId === undefined) };
      store.saveState();
      if (!subscribed(store.state.groups[id])) store.cancelGroup(id);
      if (joined && store.state.groups[id].writable) store.enqueue(hash(`welcome:${update.update_id}`), store.state.groups[id].needsTopic
        ? `请群管理员进入每个要收信号的话题，分别发送 /resume@${bot.username}。同一群可绑定多个话题。`
        : "已开启信号推送：买卖信号、4H/2H 账本和 GEX。群管理员可用 /pause 暂停、/resume 恢复，/status 查看状态。",
      undefined, id, undefined, store.state.groups[id].messageThreadId);
    }
  }
  const m = update.message;
  if (m && isGroup(m.chat)) {
    if (m.migrate_to_chat_id) store.migrate(String(m.chat.id), String(m.migrate_to_chat_id));
    if (m.migrate_from_chat_id) store.migrate(String(m.migrate_from_chat_id), String(m.chat.id));
    const id = String(m.chat.id);
    const learned = topicNameOf(m);
    const learnedThread = nameThreadId(m);
    if (learned && learnedThread !== undefined && store.state.groups[id]) {
      store.state.groups[id] = rememberTopicName(store.state.groups[id], learnedThread, learned);
      store.saveState();
    }
    const match = /^\/(start|help|status|pause|resume)(?:@([A-Za-z0-9_]+))?(?:\s|$)/.exec(m.text ?? "");
    if (match && (!match[2] || match[2].toLowerCase() === bot.username.toLowerCase())) {
      const command = match[1];
      // General 不带话题路由；只使用 Telegram 标记为话题消息的有效 ID。
      const threadId = commandThreadId(m);
      let text = `将机器人加入群并允许发送文字和图片。话题群请管理员在每个要收的话题发送 /resume@${bot.username}。/pause 暂停全群，/status 查看状态。`;
      if (["pause", "resume", "start"].includes(command)) {
        // 匿名管理员以本群身份发言；普通用户必须经 Telegram 实时确认管理员身份。
        const anonymousAdmin = m.sender_chat?.id === m.chat.id;
        const admins = !anonymousAdmin && m.from && !m.from.is_bot && !m.sender_chat
          ? await api.call<Array<{ user: { id: number }; status: string }>>("getChatAdministrators", { chat_id: id }) : [];
        const admin = anonymousAdmin || admins.some((a) => a.user.id === m.from?.id && ["creator", "administrator"].includes(a.status));
        if (!admin) text = "只有本群管理员可以暂停或恢复信号推送。";
        else if (command === "pause") {
          if (store.state.groups[id]) { store.state.groups[id].paused = true; store.saveState(); store.cancelGroup(id); }
          text = "已暂停本群全部话题的信号推送。管理员在任意话题发送 /resume 可恢复。";
        } else if (command === "start" && m.chat.is_forum && threadId === undefined) {
          text = `请进入接收信号的话题，发送 /resume@${bot.username}。若要发到 General，请在 General 发送该命令。同一群可绑定多个话题。`;
        } else {
          const self = await api.call<Member>("getChatMember", { chat_id: id, user_id: bot.id });
          const old = store.state.groups[id];
          const title = threadId !== undefined
            ? displayTopicTitle(old, threadId, topicNameOf(m))
            : m.chat.is_forum ? "General" : (m.chat.title ?? "本群");
          store.state.groups[id] = { ...old, id, title: m.chat.title ?? "", paused: false, present: present(self), writable: writable(self),
            updatedAt: m.date, nextSendAt: old?.nextSendAt ?? 0, messageThreadId: threadId, needsTopic: false,
            topics: bindTopic(old, threadId, title) };
          store.state.groups[id] = rememberTopicName(store.state.groups[id], threadId, topicNameOf(m));
          store.saveState();
          const bound = topicsOf(store.state.groups[id]).map((topic) => topic.title).join("、");
          text = subscribed(store.state.groups[id])
            ? `已绑定${threadId !== undefined ? "当前话题" : m.chat.is_forum ? " General" : "本群"}。本群接收位置：${bound}。可在其他话题再发送 /resume 增加频道。`
            : "请允许机器人在本群发送文字和图片，然后在目标话题发送 /resume。";
        }
      } else if (command === "status") {
        const group = store.state.groups[id];
        text = !group?.present ? "本群尚未订阅，请管理员发送 /resume。" : group.paused ? "本群推送已暂停。" : !group.writable ? "机器人缺少发送权限，请管理员允许发送文字和图片。"
          : group.needsTopic ? `请群管理员在接收信号的话题发送 /resume@${bot.username}。同一群可绑定多个话题。`
          : `本群推送已开启。接收位置：${topicsOf(group).map((topic) => topic.threadId === threadId ? "当前话题" : topic.title).join("、")}。可在其他话题 /resume 增加频道。`;
      }
      store.enqueue(hash(`command:${update.update_id}`), text, undefined, id, undefined, threadId);
    }
  } else if (m?.chat.type === "private" && /^\/(start|help)(?:\s|$)/.test(m.text ?? "")) {
    store.enqueue(hash(`help:${update.update_id}`), `将 @${bot.username} 加入群并允许发送文字和图片。普通群自动订阅；话题群请管理员在每个要收的话题发送 /resume@${bot.username}。/pause 暂停全群，/status 查看状态。`, undefined, String(m.chat.id));
  }
  store.state.offset = update.update_id + 1;
  store.saveState();
}
