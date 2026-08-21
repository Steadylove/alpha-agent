import { Card } from "@/components/Card";
import { MacroPhaseBanner } from "@/components/MacroPhaseBanner";
import { getDashboardData } from "@/lib/dashboard/data";
import { getMprData } from "@/lib/dashboard/mpr";
import { getRotationData } from "@/lib/dashboard/rotation";
import { getStockPanelData } from "@/lib/dashboard/stockPanel";
import Link from "next/link";
import { ArrowRight, Microscope, Radar, Repeat } from "lucide-react";
import type { LucideIcon } from "lucide-react";

export const dynamic = "force-dynamic";

/** Discord 推送链路上的三个任务，首页只关心它们跑没跑成。 */
const PUSH_JOBS = ["daily-report", "push-latest-report", "alpha-screener"];

type ModuleStat = { label: string; value: string; hint?: string };

function ModuleCard({
  href,
  icon: Icon,
  title,
  subtitle,
  stats,
}: {
  href: string;
  icon: LucideIcon;
  title: string;
  subtitle: string;
  stats: ModuleStat[];
}) {
  return (
    <Link
      href={href}
      className="group flex flex-col rounded-lg border border-zinc-800 bg-zinc-950/40 p-4 transition-colors hover:border-zinc-700"
    >
      <div className="flex items-center gap-2">
        <Icon className="h-4 w-4 text-zinc-500" />
        <span className="text-sm font-semibold text-zinc-100">{title}</span>
        <ArrowRight className="ml-auto h-4 w-4 text-zinc-600 transition-colors group-hover:text-zinc-300" />
      </div>
      <p className="mt-1 text-xs text-zinc-500">{subtitle}</p>

      <div className="mt-4 flex flex-wrap gap-x-6 gap-y-3">
        {stats.map((s) => (
          <div key={s.label}>
            <div className="font-mono text-lg text-zinc-100">{s.value}</div>
            <div className="text-xs text-zinc-500">{s.label}</div>
            {s.hint ? <div className="text-xs text-zinc-600">{s.hint}</div> : null}
          </div>
        ))}
      </div>
    </Link>
  );
}

export default async function DashboardPage() {
  const [data, mpr, rotation, panel] = await Promise.all([
    getDashboardData(),
    getMprData(),
    getRotationData(),
    getStockPanelData(),
  ]);

  const leadSector = panel.sectorClock.find((s) => s.rank === 1);
  const pushJobs = data.jobs.filter((j) => PUSH_JOBS.includes(j.name)).slice(0, 4);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-zinc-50">Overview</h1>
        <span className="font-mono text-xs text-zinc-600">
          {mpr.latest?.date ?? rotation.latestDate ?? "—"}
        </span>
      </div>

      <MacroPhaseBanner latest={mpr.latest} />

      <div className="grid gap-4 lg:grid-cols-3">
        <ModuleCard
          href="/mpr"
          icon={Radar}
          title="市场相变雷达"
          subtitle="五力场 · 三域聚合 · 传导路径"
          stats={
            mpr.latest
              ? [
                  { label: "市场风险分", value: mpr.latest.marketRiskScore.toFixed(0) },
                  { label: "SPY 破坏度", value: mpr.latest.spyDamage.toFixed(0) },
                  { label: "传导路径", value: `P${mpr.latest.pathId}` },
                ]
              : [{ label: "待运行 macro-phase", value: "—" }]
          }
        />

        <ModuleCard
          href="/rotation"
          icon={Repeat}
          title="动能轮动雷达"
          subtitle="4Q-Alpha RS · 一买二买 · 吊灯止损"
          stats={
            rotation.latestDate
              ? [
                  {
                    label: "组合净值",
                    value: `${rotation.stats.totalNavPct >= 0 ? "+" : ""}${rotation.stats.totalNavPct.toFixed(1)}%`,
                  },
                  { label: "当前持仓", value: `${rotation.holdings.length}` },
                  {
                    label: "胜率",
                    value: `${rotation.stats.winRatePct.toFixed(0)}%`,
                    hint: `${rotation.stats.trades} 笔`,
                  },
                ]
              : [{ label: "待运行 rotation-radar", value: "—" }]
          }
        />

        <ModuleCard
          href="/depth"
          icon={Microscope}
          title="个股深度面板"
          subtitle="形态阶段 · 行业时钟 · 战术指令"
          stats={
            panel.latestDate
              ? [
                  {
                    label: "覆盖标的",
                    value: `${panel.rows.length}`,
                    hint: `共 ${panel.universeSize} 只`,
                  },
                  {
                    label: "领涨行业",
                    value: leadSector?.name ?? "—",
                    hint: leadSector?.symbol,
                  },
                ]
              : [{ label: "待运行 stock-panel", value: "—" }]
          }
        />
      </div>

      <Card
        title={
          <div className="flex items-center justify-between">
            <span>Discord 推送</span>
            <Link
              href={`/reports/${data.report.date}`}
              className="text-xs font-normal text-zinc-500 transition-colors hover:text-zinc-200"
            >
              最新简报 {data.report.date} →
            </Link>
          </div>
        }
      >
        {pushJobs.length === 0 ? (
          <p className="text-sm text-zinc-500">还没有推送任务的运行记录。</p>
        ) : (
          <div className="space-y-2">
            {pushJobs.map((job) => (
              <div key={job.id} className="flex items-baseline gap-3 text-sm">
                <span
                  className="h-1.5 w-1.5 shrink-0 rounded-full"
                  style={{ background: job.status === "SUCCESS" ? "#089981" : "#f23645" }}
                />
                <span className="text-zinc-300">{job.name}</span>
                <span className="font-mono text-xs text-zinc-600">
                  {job.startedAt.slice(0, 16).replace("T", " ")}
                </span>
                <span className="ml-auto font-mono text-xs text-zinc-600">
                  {(job.durationMs / 1000).toFixed(1)}s
                </span>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
