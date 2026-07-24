import { Card } from "@/components/Card";
import { getDashboardData } from "@/lib/dashboard/data";
import Link from "next/link";

export default async function ReportsPage() {
  const data = await getDashboardData();

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold text-zinc-50">Reports</h1>
      
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
