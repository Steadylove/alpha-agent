import { Card } from "@/components/Card";
import { getDashboardData } from "@/lib/dashboard/data";
import Link from "next/link";

/** 数据每日一更，按 ISR 缓存；见首页注释。 */
export const revalidate = 300;

export default async function ReportsPage() {
  const data = await getDashboardData();

  return (
    <div className="space-y-6">
      <div className="rise-in">
        <h1 className="text-3xl font-semibold tracking-tight text-zinc-50">每日简报</h1>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-zinc-400">
          每天推送到 Discord 的市场综述，这里是网页版存档。
        </p>
      </div>

      <Link href={`/reports/${data.report.date}`} className="block">
        <Card className="hover:border-zinc-700 transition-colors cursor-pointer">
          <h2 className="text-lg font-medium text-zinc-200">{data.report.title}</h2>
          <p className="mt-2 text-sm text-zinc-400 leading-relaxed">{data.report.summary}</p>
          <div className="mt-4 text-xs text-zinc-500">{data.report.date}</div>
        </Card>
      </Link>
    </div>
  );
}
