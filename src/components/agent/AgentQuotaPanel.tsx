"use client";

import { ArrowUpRight, Gauge, LoaderCircle, Settings2 } from "lucide-react";
import type { AgentStatus } from "@/lib/siteAgent/types";
import { formatCount, formatTime } from "./api";
import styles from "./agent.module.css";

function windowDuration(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes <= 0) return "窗口时长未知";
  if (minutes % 1440 === 0) return `${minutes / 1440} 天窗口`;
  if (minutes % 60 === 0) return `${minutes / 60} 小时窗口`;
  return `${minutes} 分钟窗口`;
}

export function AgentQuotaPanel({ status, busy, onLogin }: {
  status: AgentStatus | null;
  busy: string | null;
  onLogin: () => void;
}) {
  const login = status?.login;
  const loginUrl = login?.url && /^https:\/\//i.test(login.url) ? login.url : null;

  return (
    <section className={styles.accountPanel} aria-label="账户额度与本地预算">
      <div className={styles.sectionHeading}><Gauge size={16} /><h2>账户与额度</h2></div>
      <div className={styles.accountState}>
        <span className={`${styles.dot} ${status?.authenticated ? styles.good : ""}`} />
        <strong>{!status ? "等待服务状态" : status.authenticated ? "Codex 已登录" : "Codex 未登录"}</strong>
        {status?.account?.plan && <span className={styles.badge}>{status.account.plan}</span>}
      </div>
      {status?.account && <p className={styles.hint}>登录方式：{status.account.type}</p>}
      {status && !status.authenticated && (
        <div className={styles.loginInstructions}>
          <p className={styles.hint}>连接 Codex 账户后即可开始。设备授权将在新页面完成。</p>
          <button className={styles.secondaryButton} disabled={!!busy || login?.status === "pending"} onClick={onLogin}>
            {busy === "login" ? <LoaderCircle className={styles.spinner} size={15} /> : <ArrowUpRight size={15} />}
            {login?.status === "pending" ? "等待设备授权" : "登录 Codex"}
          </button>
        </div>
      )}
      {login?.status === "pending" && (
        <div className={styles.deviceLogin} role="status">
          <strong>完成设备授权</strong>
          {login.code ? <code className={styles.deviceCode}>{login.code}</code> : <p>正在获取授权码…</p>}
          {loginUrl && <a className={styles.textLink} href={loginUrl} target="_blank" rel="noopener noreferrer">打开授权页面 <ArrowUpRight size={14} /></a>}
          <p className={styles.hint}>授权后点顶部刷新，或等待账户状态自动更新。</p>
        </div>
      )}
      {login?.status === "failed" && <p className={styles.inlineError} role="alert">{login.error || "设备授权失败，请重试。"}</p>}
      {login?.status === "complete" && !status?.authenticated && <p className={styles.hint}>设备授权已完成，正在等待账户状态更新。</p>}

      <div className={styles.quotaWindows}>
        {status?.quota.windows.length ? status.quota.windows.map((window, index) => {
          const known = typeof window.usedPercent === "number" && Number.isFinite(window.usedPercent);
          const remaining = known ? Math.max(0, Math.min(100, 100 - window.usedPercent)) : null;
          return (
            <div className={styles.quotaWindow} key={`${window.name}-${index}`}>
              <div className={styles.quotaLabel}><span>{window.name}</span><strong>{remaining === null ? "未知" : `${Math.round(remaining)}% 剩余`}</strong></div>
              {remaining !== null ? <meter className={styles.meter} min={0} max={100} value={remaining} aria-label={`${window.name}剩余百分比`}>{remaining}%</meter> : <div className={styles.unknownMeter} />}
              <div className={styles.quotaCaption}><span>{windowDuration(window.windowMinutes)}</span><span>{typeof window.resetsAt === "number" && Number.isFinite(window.resetsAt) ? `${formatTime(window.resetsAt)} 重置` : "重置时间未知"}</span></div>
            </div>
          );
        }) : <p className={styles.hint}>{!status ? "尚未获取账户额度。" : "账户额度暂不可用，剩余额度未知。"}</p>}
        {status?.quota.error && <p className={styles.hint}>{status.quota.error}</p>}
      </div>
      <p className={styles.hint}>订阅额度由整个 Codex 账户共享，其他设备与任务也会消耗。此处仅显示服务返回的窗口。</p>
      {status?.quota.updatedAt && <p className={styles.updateTime}>更新于 {formatTime(status.quota.updatedAt)}</p>}

      <div className={styles.sectionHeading}><Settings2 size={16} /><h2>本站用量</h2></div>
      {status ? <>
        <p className={styles.hint}>{status.usage.date} · 服务统计日</p>
        <dl className={styles.usageGrid}>
          <div><dt>今日请求</dt><dd>{formatCount(status.usage.turns)}<span> / 不限</span></dd></div>
          <div><dt>运行任务</dt><dd>{formatCount(status.usage.activeTasks)}</dd></div>
          <div><dt>输入 tokens</dt><dd>{formatCount(status.usage.inputTokens)}</dd></div>
          <div><dt>输出 tokens</dt><dd>{formatCount(status.usage.outputTokens)}</dd></div>
        </dl>
        <p className={styles.hint}>本站不设置每日请求或 Token 上限；单次最长 {status.settings.maxTaskMinutes} 分钟。</p>
      </> : <p className={styles.hint}>连接服务后显示实际用量。</p>}
    </section>
  );
}
