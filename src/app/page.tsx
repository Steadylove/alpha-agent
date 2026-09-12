import Link from "next/link";
import { ArrowRight } from "lucide-react";

import { getMprData } from "@/lib/dashboard/mpr";
import { getOpportunityData } from "@/lib/dashboard/opportunity";
import { getRotationData } from "@/lib/dashboard/rotation";
import { peekLiveBooks, type LiveBooksResult } from "@/lib/fund/liveBooks";
import { readSignalPoolMembers } from "@/lib/fund/signalPool";
import type { LookbackView } from "@/lib/fund/lookbackLogic";
import { bookPnlLabel } from "@/lib/discord/bookCopy";
import { macroPhaseReading } from "@/lib/scoring/mprReading";

export const dynamic = "force-dynamic";

function axisLabel(raw: string): string {
  const [day, time] = raw.split("T");
  return time ? `${day} ${time}` : day;
}

function bookOf(cache: LiveBooksResult | null, tf: "4h" | "2h"): LookbackView | null {
  return cache?.books.find((b) => b.tf === tf)?.view ?? null;
}

function toneOf(n: number): string {
  return n >= 0 ? "var(--pos)" : "var(--neg)";
}

export default async function OverviewPage() {
  const [members, books, mpr, rotation, opportunity] = await Promise.all([
    readSignalPoolMembers().catch(() => [] as string[]),
    peekLiveBooks().catch(() => null),
    getMprData(),
    getRotationData(),
    getOpportunityData().catch(() => null),
  ]);

  const h4 = bookOf(books, "4h");
  const h2 = bookOf(books, "2h");
  const env = mpr.latest ? macroPhaseReading(mpr.latest) : null;

  return (
    <div className="space-y-8">
      <div className="rise-in">
        <h1 className="text-3xl font-semibold tracking-tight text-zinc-50">总览</h1>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-zinc-400">
          现网股票池、4 小时和 2 小时账本。本根买点在信号台。市场雷达是环境，轮动是另一套日线样本，都不改这本账。
        </p>
      </div>

      <section className="rise-in space-y-3" style={{ "--rise-delay": "40ms" } as React.CSSProperties}>
        <div className="flex items-end justify-between gap-3">
          <h2 className="text-sm font-semibold text-zinc-200">现网</h2>
          <p className="text-xs text-zinc-500">
            池 {members.length} 只
            {books?.stale ? " · 账本待更新" : ""}
          </p>
        </div>
        {books?.stale && books.staleReason ? (
          <p className="text-xs text-amber-400/90">{books.staleReason}</p>
        ) : null}
        <div className="grid gap-4 md:grid-cols-2">
          <BookCard title="4 小时" href="/desk" view={h4} />
          <BookCard title="2 小时" href="/desk" view={h2} />
        </div>
        <div className="flex flex-wrap gap-3 text-sm">
          <TextLink href="/desk" label="信号台" hint="看 4H / 2H 状态" />
          <TextLink href="/fund" label="资金账本" hint="改池、开账" />
        </div>
      </section>

      <section className="rise-in space-y-3" style={{ "--rise-delay": "100ms" } as React.CSSProperties}>
        <h2 className="text-sm font-semibold text-zinc-200">环境</h2>
        <Link
          href="/mpr"
          className="lift group flex items-center justify-between gap-4 rounded-xl border border-(--border-subtle) bg-(--surface-raised) px-5 py-4 hover:border-(--border-strong) hover:bg-(--surface-hover)"
        >
          <div className="min-w-0">
            {env && mpr.latest ? (
              <>
                <p className="text-sm font-semibold text-zinc-100">
                  {env.pathLabel}
                  <span className="ml-2 font-normal text-zinc-400">{env.headline}</span>
                </p>
                <p className="mt-1 text-xs text-zinc-500">
                  压力分 {mpr.latest.marketRiskScore.toFixed(0)} · {mpr.latest.date} · 区制标签，不给仓位
                </p>
              </>
            ) : (
              <p className="text-sm text-zinc-500">日更尚未生成</p>
            )}
          </div>
          <ArrowRight className="h-4 w-4 shrink-0 text-zinc-600 group-hover:text-zinc-200" />
        </Link>
        <Link
          href="/opportunity"
          className="lift group flex items-center justify-between gap-4 rounded-xl border border-(--border-subtle) bg-(--surface-raised) px-5 py-4 hover:border-(--border-strong) hover:bg-(--surface-hover)"
        >
          <div className="min-w-0">
            <p className="text-sm font-semibold text-zinc-100">行业机会</p>
            <p className="mt-1 text-xs text-zinc-500">
              {opportunity?.asOf
                ? `截至 ${opportunity.asOf} · 领涨 ${
                    opportunity.leaders
                      .map((id) => opportunity.sectors.find((s) => s.id === id)?.name ?? id)
                      .join("、") || "—"
                  } · 回流 ${
                    opportunity.bottoming
                      .map((id) => opportunity.sectors.find((s) => s.id === id)?.name ?? id)
                      .join("、") || "—"
                  } · 改池时看，不指挥现网仓位`
                : "日更尚未生成 · 改池时看，不指挥现网仓位"}
            </p>
          </div>
          <ArrowRight className="h-4 w-4 shrink-0 text-zinc-600 group-hover:text-zinc-200" />
        </Link>
      </section>

      <section className="rise-in space-y-3" style={{ "--rise-delay": "160ms" } as React.CSSProperties}>
        <h2 className="text-sm font-semibold text-zinc-200">对照</h2>
        <Link
          href="/rotation"
          className="lift group block rounded-xl border border-(--border-subtle) bg-(--surface-raised) p-5 hover:border-(--border-strong) hover:bg-(--surface-hover)"
        >
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm font-semibold text-zinc-100">40 只日线轮动</p>
            <ArrowRight className="h-4 w-4 shrink-0 text-zinc-600 group-hover:text-zinc-200" />
          </div>
          <p className="mt-2 text-sm text-zinc-500">不是现网股票池，也不用 4H / 2H 定档。</p>
          {rotation.latestDate ? (
            <div className="mt-5 flex flex-wrap gap-x-8 gap-y-4 border-t border-(--border-subtle) pt-4">
              <Stat
                label="样本持仓"
                value={`${rotation.holdings.length}`}
                hint={rotation.latestDate}
              />
              <Stat
                label="年内净值"
                value={`${rotation.stats.totalNavPct >= 0 ? "+" : ""}${rotation.stats.totalNavPct.toFixed(1)}%`}
                color={toneOf(rotation.stats.totalNavPct)}
              />
              <Stat
                label="年内胜率"
                value={`${rotation.stats.winRatePct.toFixed(0)}%`}
                hint={`${rotation.stats.trades} 笔`}
              />
            </div>
          ) : (
            <p className="mt-4 text-sm text-zinc-500">日更尚未生成</p>
          )}
        </Link>
      </section>

      <p className="max-w-3xl border-t border-(--border-subtle) pt-6 text-xs leading-relaxed text-zinc-500">
        现网数字来自资金账本缓存，不是信号台当场扫描。本站是量化跟踪，不构成投资建议；收益为模型模拟，未计滑点与手续费。
      </p>
    </div>
  );
}

function BookCard({ title, href, view }: { title: string; href: string; view: LookbackView | null }) {
  const pnl = view ? bookPnlLabel(view.equity) : "—";
  return (
    <Link
      href={href}
      className="lift group flex flex-col rounded-xl border border-(--border-subtle) bg-(--surface-raised) p-5 hover:border-(--border-strong) hover:bg-(--surface-hover)"
    >
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-semibold text-zinc-100">{title}</p>
        <ArrowRight className="h-4 w-4 text-zinc-600 group-hover:text-zinc-200" />
      </div>
      {view ? (
        <>
          <div className="mt-5 flex flex-wrap gap-x-8 gap-y-4">
            <Stat label="持仓" value={`${view.rows.length}`} hint={`敞口 ${view.exposurePct.toFixed(0)}%`} />
            <Stat label="净值" value={pnl} color={toneOf(view.equity - 1)} hint={axisLabel(view.asOf)} />
          </div>
          {view.rows.length > 0 ? (
            <p className="mt-4 font-mono text-xs leading-relaxed text-zinc-500">
              {view.rows.map((r) => r.symbol).join("  ")}
            </p>
          ) : (
            <p className="mt-4 text-xs text-zinc-600">这本账当前空仓</p>
          )}
        </>
      ) : (
        <p className="mt-5 text-sm text-zinc-500">还没有账本缓存。去资金账本更新。</p>
      )}
    </Link>
  );
}

function Stat({
  label,
  value,
  hint,
  color,
}: {
  label: string;
  value: string;
  hint?: string;
  color?: string;
}) {
  return (
    <div>
      <div
        className={/^[+\-\d]/.test(value) ? "font-mono text-2xl leading-none" : "text-xl font-medium leading-none"}
        style={{ color: color ?? "#fafafa" }}
      >
        {value}
      </div>
      <div className="mt-2 text-xs text-zinc-500">{label}</div>
      {hint ? <div className="text-xs text-zinc-600">{hint}</div> : null}
    </div>
  );
}

function TextLink({ href, label, hint }: { href: string; hint: string; label: string }) {
  return (
    <Link
      href={href}
      className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-(--border-subtle) px-3 text-zinc-200 hover:border-(--border-strong) hover:text-white"
    >
      {label}
      <span className="text-xs text-zinc-500">{hint}</span>
    </Link>
  );
}
