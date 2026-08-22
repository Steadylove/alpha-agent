import { MacroPhaseBanner } from "@/components/MacroPhaseBanner";
import { getMprData } from "@/lib/dashboard/mpr";
import { getRotationData } from "@/lib/dashboard/rotation";
import { getStockPanelData } from "@/lib/dashboard/stockPanel";
import Link from "next/link";
import { ArrowRight, Microscope, Radar, Repeat } from "lucide-react";
import type { LucideIcon } from "lucide-react";

/**
 * 数据由每日任务链在 00:30 UTC 一次性写入，请求间不会变，
 * 因此按 ISR 缓存而非每次请求重查。这也让 Next 恢复导航预取。
 */
export const revalidate = 300;

type ModuleStat = { label: string; value: string; hint?: string; tone?: "pos" | "neg" };

function ModuleCard({
  href,
  icon: Icon,
  title,
  question,
  stats,
  delay,
}: {
  href: string;
  icon: LucideIcon;
  title: string;
  question: string;
  stats: ModuleStat[];
  delay: number;
}) {
  return (
    <Link
      href={href}
      style={{ "--rise-delay": `${delay}ms` } as React.CSSProperties}
      className="group rise-in lift flex flex-col rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-raised)] p-5 hover:border-[var(--border-strong)] hover:bg-[var(--surface-hover)]"
    >
      <div className="flex items-center gap-2.5">
        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-[var(--accent-soft)]">
          <Icon className="h-4 w-4" style={{ color: "var(--accent)" }} />
        </span>
        <span className="text-base font-semibold text-zinc-100">{title}</span>
        <ArrowRight className="ml-auto h-4 w-4 text-zinc-600 transition-transform duration-200 group-hover:translate-x-0.5 group-hover:text-zinc-200" />
      </div>
      <p className="mt-3 text-sm leading-relaxed text-zinc-500">{question}</p>

      <div className="mt-6 flex flex-wrap gap-x-8 gap-y-4 border-t border-[var(--border-subtle)] pt-4">
        {stats.map((s) => (
          <div key={s.label}>
            <div
              // 等宽字体只给数字用，套在中文上（如行业名）会显得松散别扭
              className={
                /^[+\-\d]/.test(s.value)
                  ? "font-mono text-2xl leading-none"
                  : "text-xl font-medium leading-none"
              }
              style={{
                color:
                  s.tone === "pos"
                    ? "var(--pos)"
                    : s.tone === "neg"
                      ? "var(--neg)"
                      : "#fafafa",
              }}
            >
              {s.value}
            </div>
            <div className="mt-2 text-xs text-zinc-500">{s.label}</div>
            {s.hint ? <div className="text-xs text-zinc-600">{s.hint}</div> : null}
          </div>
        ))}
      </div>
    </Link>
  );
}

export default async function DashboardPage() {
  const [mpr, rotation, panel] = await Promise.all([
    getMprData(),
    getRotationData(),
    getStockPanelData(),
  ]);

  const leadSector = panel.sectorClock.find((s) => s.rank === 1);
  const actionable = panel.rows.filter((r) =>
    ["enter_standard", "enter_light", "breakout_follow"].includes(r.tacticalAction),
  ).length;
  const asOf = mpr.latest?.date ?? rotation.latestDate ?? panel.latestDate;

  return (
    <div className="space-y-8">
      <div className="rise-in">
        <h1 className="text-3xl font-semibold tracking-tight text-zinc-50">市场罗盘</h1>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-zinc-400">
          跟踪 40 只美股核心标的的宏观环境、轮动动能与个股买卖点。
          三个模块回答三个问题：现在能不能重仓、该拿哪几只、这一只今天该怎么办。
        </p>
        {asOf ? (
          <p className="mt-2 font-mono text-xs text-zinc-600">数据截至 {asOf}</p>
        ) : null}
      </div>

      <div className="rise-in" style={{ "--rise-delay": "60ms" } as React.CSSProperties}>
        <MacroPhaseBanner latest={mpr.latest} />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <ModuleCard
          delay={140}
          href="/mpr"
          icon={Radar}
          title="市场相变雷达"
          question="现在的市场环境健康吗？该不该降低仓位？"
          stats={
            mpr.latest
              ? [
                  { label: "市场风险分", value: mpr.latest.marketRiskScore.toFixed(0), hint: "满分 100" },
                  { label: "所处阶段", value: `P${mpr.latest.pathId}` },
                ]
              : [{ label: "数据生成中", value: "—" }]
          }
        />

        <ModuleCard
          delay={220}
          href="/rotation"
          icon={Repeat}
          title="动能轮动雷达"
          question="强势股里现在该持有哪几只？各占多少仓位？"
          stats={
            rotation.latestDate
              ? [
                  {
                    label: "年内净值",
                    value: `${rotation.stats.totalNavPct >= 0 ? "+" : ""}${rotation.stats.totalNavPct.toFixed(1)}%`,
                    tone: rotation.stats.totalNavPct >= 0 ? "pos" : "neg",
                  },
                  { label: "当前持仓", value: `${rotation.holdings.length}`, hint: "只" },
                  {
                    label: "年内胜率",
                    value: `${rotation.stats.winRatePct.toFixed(0)}%`,
                    hint: `${rotation.stats.trades} 笔交易`,
                  },
                ]
              : [{ label: "数据生成中", value: "—" }]
          }
        />

        <ModuleCard
          delay={300}
          href="/depth"
          icon={Microscope}
          title="个股深度面板"
          question="逐只看：现在是建仓、持有、还是回避？"
          stats={
            panel.latestDate
              ? [
                  { label: "今日可建仓", value: `${actionable}`, hint: `共跟踪 ${panel.rows.length} 只` },
                  {
                    label: "领涨行业",
                    value: leadSector?.name ?? "—",
                    hint: leadSector?.symbol,
                  },
                ]
              : [{ label: "数据生成中", value: "—" }]
          }
        />
      </div>

      <p className="max-w-3xl border-t border-[var(--border-subtle)] pt-6 text-xs leading-relaxed text-zinc-500">
        本站展示的是量化模型的跟踪结果，不构成投资建议。所有收益数字均为模型模拟，
        未计入滑点、手续费与实际成交偏差，且标的池为事后选定，历史表现存在幸存者偏差。
      </p>
    </div>
  );
}
