"use client";

import { useState, type ElementType, type FormEvent, type ReactNode } from "react";
import { Activity, Archive, ArrowUp, Check, ChevronDown, LoaderCircle, MessageSquare, Pencil, ShieldCheck, Square, SquareTerminal, X } from "lucide-react";
import type { AgentApproval, AgentApprovalDecision, AgentStatus, AgentThread, AgentThreadPatch, AgentThreadStatus } from "@/lib/siteAgent/types";
import { formatCount, formatTime } from "./api";
import styles from "./agent.module.css";

export const threadStatusLabels: Record<AgentThreadStatus, string> = {
  idle: "就绪", running: "执行中", waiting: "等待确认", failed: "执行失败", interrupted: "已中断",
};

export function AgentConversation({ thread, loading, loadError, otherTaskActive, status, busy, draft, setDraft, onSend, onInterrupt, onPatch, onApprove }: {
  thread: AgentThread | null;
  loading: boolean;
  loadError: string | null;
  otherTaskActive: boolean;
  status: AgentStatus | null;
  busy: string | null;
  draft: string;
  setDraft: (value: string) => void;
  onSend: () => void;
  onInterrupt: () => void;
  onPatch: (patch: AgentThreadPatch) => Promise<boolean>;
  onApprove: (id: string, decision: AgentApprovalDecision) => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [title, setTitle] = useState("");
  const active = thread?.status === "running" || thread?.status === "waiting";
  const disabledReason = loading ? loadError ? "对话读取失败，请刷新后重试。" : "正在读取对话…" : thread?.archived ? "恢复归档后可继续对话。" : active ? "回答仍在生成，可先停止或等待完成。" : !status?.available ? "服务尚未连接，连接后可以发送问题。" : !status.authenticated ? "请先完成 Codex 账户授权。" : otherTaskActive ? "另一项回答正在生成，请等待完成。" : null;

  async function rename(event: FormEvent) {
    event.preventDefault();
    if (title.trim() && await onPatch({ title: title.trim() })) setRenaming(false);
  }

  return (
    <section className={styles.conversation} aria-label="Codex 对话">
      <header className={styles.conversationHeader}>
        <div className={styles.conversationTitle}>
          <span className={styles.eyebrow}>{thread ? "CONVERSATION" : "NEW CONVERSATION"}</span>
          {renaming && thread ? <form className={styles.renameForm} onSubmit={rename}>
            <input aria-label="对话名称" autoFocus maxLength={160} required value={title} onChange={(event) => setTitle(event.target.value)} />
            <button className={styles.iconButton} type="submit" disabled={!!busy || !title.trim()} aria-label="保存名称"><Check size={17} /></button>
            <button className={styles.iconButton} type="button" onClick={() => setRenaming(false)} aria-label="取消改名"><X size={17} /></button>
          </form> : <h2>{thread?.title || (loading ? "正在读取对话" : "开始新对话")}</h2>}
          {thread && <div className={styles.threadMetadata}><span className={styles.badge}>{threadStatusLabels[thread.status]}</span><span>只读研究</span><span>{thread.model} · {thread.effort}</span>{thread.archived && <span>已归档</span>}</div>}
        </div>
        {thread && <div className={styles.headerActions}>
          <button className={styles.iconButton} onClick={() => { setTitle(thread.title); setRenaming(true); }} disabled={!!busy} aria-label="重命名对话" title="重命名对话"><Pencil size={16} /></button>
          <button className={styles.iconButton} onClick={() => void onPatch({ archived: !thread.archived })} disabled={!!busy || active} aria-label={thread.archived ? "恢复对话" : "归档对话"} title={active ? "任务完成后可归档" : thread.archived ? "恢复对话" : "归档对话"}><Archive size={16} /></button>
        </div>}
      </header>

      <div className={styles.transcript}>
        {loading ? <div className={styles.emptyState} role="status">{loadError ? <><MessageSquare size={25} /><p>暂时无法读取这段对话，请刷新状态后重试。</p></> : <><LoaderCircle size={25} className={styles.spinner} /><p>正在读取对话…</p></>}</div> : !thread?.messages.length ? <div className={styles.emptyState}>
          <div className={styles.emptyIcon}><SquareTerminal size={28} strokeWidth={1.4} /></div>
          <h3>有什么想了解的？</h3>
          <p>询问 Trend Adaptive 的数据、策略逻辑和网站状态。回答来自项目资料与只读研究，不会修改文件或生产数据。</p>
          <div className={styles.suggestions}>
            {["梳理当前网站的数据流与关键模块", "检查最近复盘数据的一致性，列出证据", "分析一个页面问题，先给出排查步骤"].map((suggestion) => <button key={suggestion} type="button" onClick={() => setDraft(suggestion)} disabled={!!busy || !!thread?.archived}><MessageSquare size={14} /><span>{suggestion}</span></button>)}
          </div>
        </div> : <div className={styles.messages} aria-label="消息记录">
          {thread.messages.map((message) => <article key={message.id} className={`${styles.message} ${message.role === "user" ? styles.userMessage : ""}`}>
            <div className={styles.messageHeading}><strong>{message.role === "user" ? "你" : "Codex"}</strong><time dateTime={message.createdAt}>{formatTime(message.createdAt)}</time></div>
            <div className={`${styles.messageText} ${styles.markdown}`}>
              {message.text ? <MarkdownText text={message.text} /> : active && message.role === "assistant" ? "正在生成…" : "（无文本内容）"}
            </div>
          </article>)}
        </div>}
        {thread?.error && <div className={styles.errorNotice} role="alert">{thread.error}</div>}
        {thread && !!thread.activities.length && <details className={styles.activityPanel} open={active || undefined}>
          <summary><Activity size={15} /><span>执行活动</span><span className={styles.badge}>{thread.activities.length}</span><ChevronDown size={14} /></summary>
          <ul className={styles.activities}>{thread.activities.map((activity) => <li key={activity.id}>
            <div className={styles.activityTitle}><strong>{activity.title}</strong><span>{activity.status}</span></div>
            {activity.detail && <details><summary>查看详情</summary><pre>{activity.detail}</pre></details>}
          </li>)}</ul>
        </details>}
        {thread?.approvals.map((approval) => <ApprovalCard key={approval.id} approval={approval} busy={!!busy} onRespond={(decision) => onApprove(approval.id, decision)} />)}
        {active && <div className={styles.runningState} role="status"><LoaderCircle size={15} className={styles.spinner} />{thread.status === "waiting" ? "等待你的确认，任务尚未继续。" : "Codex 正在执行，进度每 2 秒更新。"}</div>}
      </div>

      <form className={styles.composer} onSubmit={(event) => { event.preventDefault(); if (!disabledReason && !busy && draft.trim()) onSend(); }}>
        <label className={styles.composerLabel} htmlFor="agent-message">{thread ? "继续对话" : "向 Codex 提问"}</label>
        <textarea id="agent-message" value={draft} onChange={(event) => setDraft(event.target.value)} maxLength={24_000} rows={3} placeholder="输入问题…" disabled={!!busy || !!thread?.archived || loading} onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); }
        }} />
        <div className={styles.composerFooter}>
          <p className={styles.hint}>{disabledReason || "Enter 发送 · Shift + Enter 换行 · 只读研究模式"}</p>
          {active ? <button className={styles.secondaryButton} type="button" disabled={!!busy} onClick={onInterrupt}>{busy === "interrupt" ? <LoaderCircle size={15} className={styles.spinner} /> : <Square size={13} />}停止</button> : <button className={styles.primaryButton} type="submit" disabled={!!busy || !!disabledReason || !draft.trim()}>{busy === "send" ? <LoaderCircle className={styles.spinner} size={16} /> : <ArrowUp size={16} />}{busy === "send" ? "发送中" : "发送"}</button>}
        </div>
        {thread && <p className={styles.tokenTotal}>本对话累计 · 输入 {formatCount(thread.inputTokens)} / 输出 {formatCount(thread.outputTokens)} tokens</p>}
      </form>
    </section>
  );
}

/**
 * A deliberately small, safe Markdown renderer for model output.
 *
 * The workbench does not need arbitrary HTML. Rendering the small Markdown
 * subset here keeps streaming output safe (React escapes text by default),
 * avoids a new client bundle dependency, and still makes headings, lists,
 * tables, links, quotes, code and paragraphs easy to scan.
 */
export function MarkdownText({ text }: { text: string }) {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let index = 0;
  let blockKey = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) { index += 1; continue; }

    const fence = line.match(/^\s*(```+|~~~+)\s*([^\s`]*)\s*$/);
    if (fence) {
      const marker = fence[1][0];
      const content: string[] = [];
      index += 1;
      while (index < lines.length && !new RegExp(`^\\s*${marker}{3,}\\s*$`).test(lines[index])) {
        content.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push(<pre className={styles.markdownCode} key={`code-${blockKey++}`}><code data-language={fence[2] || undefined}>{content.join("\n")}</code></pre>);
      continue;
    }

    const heading = line.match(/^\s*(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading) {
      const Heading = `h${heading[1].length}` as ElementType;
      blocks.push(<Heading key={`heading-${blockKey++}`}>{renderInline(heading[2])}</Heading>);
      index += 1;
      continue;
    }

    if (/^\s*(?:[-*_]\s*){3,}$/.test(line)) {
      blocks.push(<hr key={`rule-${blockKey++}`} />);
      index += 1;
      continue;
    }

    if (line.trimStart().startsWith(">")) {
      const quote: string[] = [];
      while (index < lines.length && lines[index].trimStart().startsWith(">")) {
        quote.push(lines[index].trimStart().replace(/^>\s?/, ""));
        index += 1;
      }
      blocks.push(<blockquote key={`quote-${blockKey++}`}>{renderParagraphs(quote)}</blockquote>);
      continue;
    }

    const firstList = parseListItem(line);
    if (firstList) {
      const ordered = firstList.ordered;
      const items: string[] = [firstList.value];
      index += 1;
      while (index < lines.length) {
        const item = parseListItem(lines[index]);
        if (!item || item.ordered !== ordered) break;
        items.push(item.value);
        index += 1;
      }
      const List = ordered ? "ol" : "ul";
      blocks.push(<List key={`list-${blockKey++}`}>{items.map((item, itemIndex) => <li key={itemIndex}>{renderInline(item)}</li>)}</List>);
      continue;
    }

    if (isTableSeparator(lines[index + 1]) && line.includes("|")) {
      const header = splitTableRow(line);
      const rows: string[][] = [];
      index += 2;
      while (index < lines.length && lines[index].includes("|") && lines[index].trim()) {
        rows.push(splitTableRow(lines[index]));
        index += 1;
      }
      blocks.push(<table className={styles.markdownTable} key={`table-${blockKey++}`}><thead><tr>{header.map((cell, cellIndex) => <th key={cellIndex}>{renderInline(cell)}</th>)}</tr></thead><tbody>{rows.map((row, rowIndex) => <tr key={rowIndex}>{header.map((_, cellIndex) => <td key={cellIndex}>{renderInline(row[cellIndex] ?? "")}</td>)}</tr>)}</tbody></table>);
      continue;
    }

    const paragraph: string[] = [line];
    index += 1;
    while (index < lines.length && lines[index].trim() && !isBlockStart(lines[index], lines[index + 1])) {
      paragraph.push(lines[index]);
      index += 1;
    }
    blocks.push(<p key={`paragraph-${blockKey++}`}>{paragraph.map((part, partIndex) => <span key={partIndex}>{part}{partIndex < paragraph.length - 1 ? <br /> : null}</span>)}</p>);
  }

  return <>{blocks}</>;
}

function parseListItem(line: string): { ordered: boolean; value: string } | null {
  const match = line.match(/^\s*(?:(\d+)[.)]|[-+*])\s+(.+?)\s*$/);
  return match ? { ordered: !!match[1], value: match[2] } : null;
}

function isTableSeparator(line: string | undefined): boolean {
  if (!line || !line.includes("|")) return false;
  const cells = splitTableRow(line);
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell.trim()));
}

function splitTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split("|").map((cell) => cell.trim());
}

function isBlockStart(line: string, nextLine?: string): boolean {
  return /^\s*(?:#{1,6}\s|```+|~~~+|>|(?:[-+*]\s+|\d+[.)]\s+))/.test(line) || /^\s*(?:[-*_]\s*){3,}$/.test(line) || (line.includes("|") && isTableSeparator(nextLine));
}

function renderParagraphs(lines: string[]): ReactNode[] {
  const groups: string[][] = [];
  for (const line of lines) {
    if (!line.trim()) groups.push([]);
    else if (!groups.length || groups[groups.length - 1].length === 0) groups.push([line]);
    else groups[groups.length - 1].push(line);
  }
  return groups.filter((group) => group.length).map((group, index) => <p key={index}>{group.map((line, lineIndex) => <span key={lineIndex}>{renderInline(line)}{lineIndex < group.length - 1 ? <br /> : null}</span>)}</p>);
}

function renderInline(value: string): ReactNode[] {
  const result: ReactNode[] = [];
  const token = /(\*\*[^*\n]+\*\*|__[^_\n]+__|`[^`\n]+`|\[[^\]\n]+\]\([^\s)]+(?:\s+"[^"]*")?\)|\*[^*\n]+\*|_[^_\n]+_)/g;
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = token.exec(value))) {
    if (match.index > cursor) result.push(value.slice(cursor, match.index));
    const source = match[0];
    if (source.startsWith("**") || source.startsWith("__")) result.push(<strong key={`${match.index}-strong`}>{source.slice(2, -2)}</strong>);
    else if (source.startsWith("`")) result.push(<code className={styles.markdownInlineCode} key={`${match.index}-code`}>{source.slice(1, -1)}</code>);
    else if (source.startsWith("[")) {
      const link = source.match(/^\[([^\]]+)\]\(([^\s)]+)(?:\s+"[^"]*")?\)$/);
      if (link && /^(?:https?:\/\/|mailto:)/i.test(link[2])) result.push(<a key={`${match.index}-link`} href={link[2]} target="_blank" rel="noreferrer">{link[1]}</a>);
      else result.push(source);
    } else if (source.startsWith("*") || source.startsWith("_")) result.push(<em key={`${match.index}-em`}>{source.slice(1, -1)}</em>);
    else result.push(source);
    cursor = match.index + source.length;
  }
  if (cursor < value.length) result.push(value.slice(cursor));
  return result;
}

function ApprovalCard({ approval, busy, onRespond }: { approval: AgentApproval; busy: boolean; onRespond: (decision: AgentApprovalDecision) => void }) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const questions = approval.questions ?? [];
  const answered = questions.every((question) => answers[question.id]?.trim());
  return (
    <form className={styles.approvalCard} onSubmit={(event) => { event.preventDefault(); onRespond({ decision: "accept", ...(questions.length ? { answers: Object.fromEntries(Object.entries(answers).map(([id, answer]) => [id, [answer.trim()]])) } : {}) }); }}>
      <div className={styles.sectionHeading}><ShieldCheck size={18} /><h3>{approval.kind === "question" ? "需要你的回答" : "需要你的批准"}</h3></div>
      <strong>{approval.title}</strong>
      <pre className={styles.approvalDetail}>{approval.detail}</pre>
      {questions.map((question) => <fieldset className={styles.question} key={question.id}>
        <legend>{question.header}: {question.question}</legend>
        {question.options?.map((option) => <label className={styles.answerOption} key={option.label}>
          <input type="radio" name={`${approval.id}-${question.id}`} value={option.label} checked={answers[question.id] === option.label} onChange={() => setAnswers({ ...answers, [question.id]: option.label })} disabled={busy} />
          <span><strong>{option.label}</strong><span>{option.description}</span></span>
        </label>)}
        <label className={styles.answerText}>{question.options?.length ? "或填写其他回答" : "你的回答"}<input value={answers[question.id] ?? ""} onChange={(event) => setAnswers({ ...answers, [question.id]: event.target.value })} maxLength={2000} required disabled={busy} /></label>
      </fieldset>)}
      <div className={styles.approvalActions}><button className={styles.secondaryButton} type="button" disabled={busy} onClick={() => onRespond({ decision: "decline" })}><X size={15} />{approval.kind === "question" ? "取消回答" : "拒绝"}</button><button className={styles.primaryButton} type="submit" disabled={busy || !answered}><Check size={15} />{approval.kind === "question" ? "提交回答" : "批准本次操作"}</button></div>
    </form>
  );
}
