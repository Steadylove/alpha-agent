"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { AlertCircle, Archive, ArrowRight, LoaderCircle, LockKeyhole, LogOut, MessageSquare, PanelLeft, Plus, RefreshCw, SquareTerminal } from "lucide-react";
import { PageHeading } from "@/components/PageHeading";
import type { AgentApprovalDecision, AgentStatus, AgentThread, AgentThreadPatch, AgentThreadSummary } from "@/lib/siteAgent/types";
import { AgentConversation, threadStatusLabels } from "./AgentConversation";
import { AgentApiError, agentRequest, errorMessage, formatTime } from "./api";
import styles from "./agent.module.css";

type OwnerSession = { authenticated: boolean; configured: boolean };

/**
 * Polling and mutations can complete in either order.  A GET that started
 * before a turn delta was received must never replace the newer in-memory
 * snapshot with an older one.  The server's updatedAt is the primary cursor;
 * equal timestamps are possible when several deltas arrive in one millisecond,
 * so the content size is used as a monotonic tie breaker as well.
 */
function mergeThreadSnapshot(current: AgentThread | null, next: AgentThread): AgentThread {
  if (!current || current.id !== next.id) return next;
  if (next.updatedAt > current.updatedAt) return next;
  if (next.updatedAt < current.updatedAt) return current;
  const currentText = current.messages.reduce((total, message) => total + message.text.length, 0);
  const nextText = next.messages.reduce((total, message) => total + message.text.length, 0);
  if (next.messages.length < current.messages.length || nextText < currentText) return current;
  if (next.activities.length < current.activities.length) return current;
  return next;
}

export function AgentWorkbench() {
  const [session, setSession] = useState<OwnerSession | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [checking, setChecking] = useState(true);
  const [busy, setBusy] = useState(false);
  const [retry, setRetry] = useState(0);
  const loginPending = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    agentRequest<OwnerSession>("/session", { signal: controller.signal }).then((value) => {
      if (!controller.signal.aborted) { setSession(value); setError(null); }
    }).catch((reason) => {
      if (!controller.signal.aborted) setError(errorMessage(reason));
    }).finally(() => { if (!controller.signal.aborted) setChecking(false); });
    return () => controller.abort();
  }, [retry]);

  const expireSession = useCallback(() => {
    setSession({ authenticated: false, configured: true });
    setError("站点登录已过期，请重新登录。");
  }, []);

  async function login(event: FormEvent) {
    event.preventDefault();
    if (loginPending.current || !password) return;
    loginPending.current = true;
    setBusy(true);
    setError(null);
    try {
      setSession(await agentRequest<OwnerSession>("/session", { method: "POST", body: JSON.stringify({ password }) }));
      setPassword("");
    } catch (reason) { setError(errorMessage(reason)); }
    finally { loginPending.current = false; setBusy(false); }
  }

  async function logout() {
    if (loginPending.current) return;
    loginPending.current = true;
    setBusy(true);
    try {
      setSession(await agentRequest<OwnerSession>("/session", { method: "DELETE" }));
      setError(null);
    } catch (reason) { setError(errorMessage(reason)); }
    finally { loginPending.current = false; setBusy(false); }
  }

  return (
    <div className={styles.workbench}>
      <PageHeading eyebrow="CODEX RESEARCH" title="Codex 问答" english="Ask. Read. Understand."
        description="围绕 Trend Adaptive 提问，获得基于项目数据的只读分析。"
        action={session?.authenticated ? <button className={styles.secondaryButton} disabled={busy} onClick={() => void logout()}><LogOut size={15} />{busy ? "退出中…" : "退出站点登录"}</button> : <span className={styles.ownerBadge}><LockKeyhole size={14} />仅站点所有者</span>} />
      {session?.authenticated ? <>
        {error && <Notice>{error}</Notice>}
        <ConnectedWorkbench onUnauthorized={expireSession} />
      </> : <section className={styles.ownerGate} aria-label="站点所有者登录">
        <div className={styles.gateIcon}><SquareTerminal size={30} strokeWidth={1.3} /></div>
        <span className={styles.eyebrow}>YOUR PRIVATE WORKSPACE</span>
        <h2>{checking ? "正在检查工作台" : session?.configured === false ? "工作台尚未配置" : "登录你的工作台"}</h2>
        <p>{checking ? "正在确认站点登录状态。" : session?.configured === false ? "站点尚未启用所有者访问。配置完成后，这里会开放登录入口。" : "输入站点所有者密码，访问你的 Codex 只读问答。"}</p>
        {error && <Notice>{error}</Notice>}
        {checking ? <LoaderCircle className={styles.spinner} aria-label="加载中" size={22} /> : session?.configured ? <form className={styles.ownerForm} onSubmit={login}>
          <label htmlFor="owner-password">所有者密码</label>
          <input id="owner-password" name="password" type="password" autoComplete="current-password" required value={password} onChange={(event) => setPassword(event.target.value)} disabled={busy} />
          <button className={styles.primaryButton} disabled={busy || !password} type="submit">{busy ? <LoaderCircle className={styles.spinner} size={16} /> : <ArrowRight size={16} />}{busy ? "验证中…" : "进入工作台"}</button>
        </form> : <button className={styles.secondaryButton} onClick={() => { setChecking(true); setRetry((value) => value + 1); }}><RefreshCw size={15} />重新检查</button>}
        <p className={styles.gateFootnote}>站点登录与 Codex 账户授权相互独立。</p>
      </section>}
    </div>
  );
}

function Notice({ children }: { children: React.ReactNode }) {
  return <div className={styles.errorNotice} role="alert"><AlertCircle size={17} /><span>{children}</span></div>;
}

function ConnectedWorkbench({ onUnauthorized }: { onUnauthorized: () => void }) {
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [threads, setThreads] = useState<AgentThreadSummary[]>([]);
  const [thread, setThread] = useState<AgentThread | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [threadError, setThreadError] = useState<string | null>(null);
  const [listLoading, setListLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [showArchived, setShowArchived] = useState(false);
  const [mobileSidebar, setMobileSidebar] = useState(false);
  const [draft, setDraft] = useState("");
  const mutationPending = useRef(false);
  const draftCache = useRef<Record<string, string>>({});
  const current = thread?.id === selectedId ? thread : null;

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let pollDelay = 60_000;
    async function pollStatus() {
      try {
        const result = await agentRequest<AgentStatus>("/status", { signal: controller.signal });
        if (!controller.signal.aborted) {
          pollDelay = result.login.status === "pending" ? 3_000 : 60_000;
          setStatus(result);
          setStatusError(null);
          // A previous mutation can leave a stale CSRF warning visible even
          // after the connection has recovered. Clear that transient warning
          // once the worker status is healthy again.
          setError((value) => value === "仅允许本站发起操作" ? null : value);
        }
      } catch (reason) {
        if (!controller.signal.aborted) {
          if (reason instanceof AgentApiError && reason.status === 401) onUnauthorized();
          else setStatusError(errorMessage(reason));
        }
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(pollStatus, pollDelay);
      }
    }
    void pollStatus();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [refresh, onUnauthorized]);

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function pollThreads() {
      let active = false;
      const results = await Promise.allSettled([
        agentRequest<{ threads: AgentThreadSummary[] }>("/threads", { signal: controller.signal }),
        selectedId ? agentRequest<AgentThread>(`/threads/${encodeURIComponent(selectedId)}`, { signal: controller.signal }) : Promise.resolve(null),
      ]);
      if (controller.signal.aborted) return;
      const [list, detail] = results;
      if (list.status === "fulfilled") {
        setThreads(list.value.threads);
        active = list.value.threads.some((item) => item.status === "running" || item.status === "waiting");
      }
      if (detail.status === "fulfilled" && detail.value) {
        const snapshot = detail.value;
        setThread((current) => mergeThreadSnapshot(current, snapshot));
        active ||= snapshot.status === "running" || snapshot.status === "waiting";
      }
      const unauthorized = results.some((item) => item.status === "rejected" && item.reason instanceof AgentApiError && item.reason.status === 401);
      const failure = results.find((item) => item.status === "rejected");
      if (unauthorized) onUnauthorized();
      else if (failure?.status === "rejected") setThreadError(errorMessage(failure.reason));
      else setThreadError(null);
      setListLoading(false);
      // During a turn use a short, bounded snapshot interval so deltas appear
      // continuously without opening a second long-lived stream per tab.
      // The merge guard above prevents an older in-flight GET from regressing
      // the visible answer when a delta and a poll complete together.
      timer = setTimeout(pollThreads, active ? 1_000 : 15_000);
    }
    void pollThreads();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [selectedId, refresh, onUnauthorized]);

  async function mutate(name: string, action: () => Promise<void>): Promise<boolean> {
    if (mutationPending.current) return false;
    mutationPending.current = true;
    setBusy(name);
    setError(null);
    try { await action(); return true; }
    catch (reason) {
      if (reason instanceof AgentApiError && reason.status === 401) onUnauthorized();
      else setError(errorMessage(reason));
      return false;
    } finally {
      mutationPending.current = false;
      setBusy(null);
      setRefresh((value) => value + 1);
    }
  }

  function selectThread(id: string | null) {
    if (mutationPending.current) return;
    draftCache.current[selectedId ?? "new"] = draft;
    setDraft(draftCache.current[id ?? "new"] ?? "");
    setSelectedId(id);
    setThreadError(null);
    setError(null);
    setMobileSidebar(false);
  }

  async function send() {
    if (!draft.trim()) return;
    await mutate("send", async () => {
      let target = current;
      if (!target) {
        const selectedModel = status?.models.find((item) => item.id === "gpt-6.1-sol") ?? status?.models.find((item) => item.isDefault) ?? status?.models[0];
        target = await agentRequest<AgentThread>("/threads", { method: "POST", body: JSON.stringify({ mode: "research", ...(selectedModel ? { model: selectedModel.id, effort: selectedModel.defaultEffort } : {}) }) });
        setThread((current) => mergeThreadSnapshot(current, target!));
        setSelectedId(target.id);
      }
      const result = await agentRequest<AgentThread>(`/threads/${encodeURIComponent(target.id)}/messages`, { method: "POST", body: JSON.stringify({ text: draft.trim() }) });
      setThread((current) => mergeThreadSnapshot(current, result));
      draftCache.current[target.id] = "";
      if (!current) draftCache.current.new = "";
      setDraft("");
    });
  }

  async function patchThread(patch: AgentThreadPatch): Promise<boolean> {
    if (!current) return false;
    return mutate("patch", async () => {
      const result = await agentRequest<AgentThread>(`/threads/${encodeURIComponent(current.id)}`, { method: "PATCH", body: JSON.stringify(patch) });
      setThread((snapshot) => mergeThreadSnapshot(snapshot, result));
    });
  }

  function interrupt() {
    if (!current) return;
    void mutate("interrupt", async () => {
      const result = await agentRequest<AgentThread>(`/threads/${encodeURIComponent(current.id)}/interrupt`, { method: "POST", body: "{}" });
      setThread((snapshot) => mergeThreadSnapshot(snapshot, result));
    });
  }

  function approve(id: string, decision: AgentApprovalDecision) {
    if (!current) return;
    void mutate("approval", async () => {
      const result = await agentRequest<AgentThread>(`/threads/${encodeURIComponent(current.id)}/approvals/${encodeURIComponent(id)}`, { method: "POST", body: JSON.stringify(decision) });
      setThread((snapshot) => mergeThreadSnapshot(snapshot, result));
    });
  }

  // Do not surface legacy workspace threads in the read-only workbench.
  const visibleThreads = threads.filter((item) => item.archived === showArchived && item.mode === "research");
  const loading = selectedId !== null && !current;
  const connected = status?.available && !statusError;

  return (
    <>
      <div className={styles.statusBar}>
        <div className={styles.connectionState}><span className={`${styles.dot} ${connected ? styles.good : ""}`} /><strong>{statusError ? "连接异常" : !status ? "连接中" : status.available ? "服务已连接" : "服务不可用"}</strong><span className={styles.statusCaption}>{status?.authenticated ? "账户已授权" : "等待 Codex 授权"}</span></div>
        <div className={styles.headerActions}><button className={`${styles.secondaryButton} ${styles.mobileToggle}`} onClick={() => setMobileSidebar(!mobileSidebar)} aria-expanded={mobileSidebar} aria-controls="agent-sidebar"><PanelLeft size={15} />会话</button><button className={styles.iconButton} disabled={!!busy} onClick={() => setRefresh((value) => value + 1)} aria-label="刷新状态" title="刷新状态"><RefreshCw size={16} /></button></div>
      </div>
      {(error || statusError || threadError || status?.error) && <Notice>{error || statusError || threadError || status?.error}</Notice>}
      <div className={styles.workspaceGrid}>
        <aside id="agent-sidebar" className={`${styles.sidebar} ${mobileSidebar ? styles.sidebarOpen : ""}`}>
          <button className={styles.newThreadButton} disabled={!!busy} onClick={() => selectThread(null)}><Plus size={17} />新建对话</button>
          <div className={styles.threadListHeading}><h2>{showArchived ? "已归档对话" : "最近对话"}</h2><button className={styles.iconButton} onClick={() => setShowArchived(!showArchived)} aria-label={showArchived ? "查看最近对话" : "查看归档对话"} aria-pressed={showArchived} title={showArchived ? "查看最近对话" : "查看归档对话"}>{showArchived ? <MessageSquare size={15} /> : <Archive size={15} />}</button></div>
          <nav className={styles.threadList} aria-label="对话列表">
            {listLoading ? <p className={styles.listEmpty}><LoaderCircle className={styles.spinner} size={15} />正在读取会话…</p> : !visibleThreads.length ? <p className={styles.listEmpty}>{threadError ? "会话暂不可用" : showArchived ? "还没有归档对话" : "还没有对话，从一个问题开始"}</p> : visibleThreads.map((item) => <button key={item.id} className={`${styles.threadButton} ${item.id === selectedId ? styles.selectedThread : ""}`} aria-current={item.id === selectedId ? "true" : undefined} onClick={() => selectThread(item.id)} disabled={!!busy}>
              <span className={styles.threadButtonTitle}>{item.title}</span><span className={styles.threadButtonMeta}><span className={item.status === "waiting" ? styles.attention : ""}>{threadStatusLabels[item.status]}</span><time dateTime={item.updatedAt}>{formatTime(item.updatedAt)}</time></span>
            </button>)}
          </nav>
          <p className={styles.readOnlyNote}>只读研究模式<br />不会修改网站文件或生产数据。</p>
        </aside>
        <AgentConversation key={selectedId ?? "new"} thread={current} loading={loading} loadError={threadError} otherTaskActive={threads.some((item) => item.id !== selectedId && (item.status === "running" || item.status === "waiting"))} status={statusError ? null : status} busy={busy} draft={draft} setDraft={setDraft} onSend={() => void send()} onInterrupt={interrupt} onPatch={patchThread} onApprove={approve} />
      </div>
    </>
  );
}
