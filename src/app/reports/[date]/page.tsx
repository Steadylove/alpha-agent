import { Card } from "@/components/Card";
import { getDashboardData } from "@/lib/dashboard/data";
import { ReportMarkdown } from "@/components/ReportMarkdown";

export default async function ReportDetailPage({ params }: { params: Promise<{ date: string }> }) {
  const { date } = await params;
  const data = await getDashboardData();

  return (
    <div className="space-y-6 max-w-4xl">
      <h1 className="text-2xl font-semibold text-zinc-50">{date} Report</h1>
      <Card>
        <div className="px-2">
          <ReportMarkdown content={data.report.body} />
        </div>
      </Card>
    </div>
  );
}
