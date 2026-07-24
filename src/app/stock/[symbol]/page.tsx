import { Card, MetricCard } from "@/components/Card";
import { getDashboardData } from "@/lib/dashboard/data";
import { notFound } from "next/navigation";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";

export default async function StockDetailPage({ params }: { params: Promise<{ symbol: string }> }) {
  const { symbol } = await params;
  const data = await getDashboardData();
  const stock = data.stocks.find((item) => item.symbol === symbol.toUpperCase());

  if (!stock) {
    notFound();
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Link href="/stocks" className="text-zinc-500 hover:text-zinc-300 transition-colors">
          <ArrowLeft className="h-5 w-5" />
        </Link>
        <div>
          <h1 className="text-2xl font-semibold text-zinc-50 flex items-baseline gap-2">
            {stock.symbol} <span className="text-sm font-normal text-zinc-500">{stock.name}</span>
          </h1>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-4">
        <MetricCard label="Total Score" value={`${stock.totalScore}`} valueColor="emerald.4" />
        <MetricCard label="Rank" value={`#${stock.rank}`} />
        <MetricCard label="Sector" value={stock.sector} valueColor="cyan.4" />
        <MetricCard label="Status" value={stock.status} valueColor={
          stock.status === 'FOCUS' ? 'emerald.4' : 
          stock.status === 'WATCH' ? 'blue.4' : 
          stock.status === 'NEW' ? 'amber.4' : 
          stock.status === 'DOWNGRADED' ? 'rose.4' : undefined
        } />
      </div>

      <Card title="Score Breakdown">
        <div className="grid gap-4 md:grid-cols-5">
          <MetricCard label="RPS" value={`${stock.rpsScore}`} hint="/ 25" />
          <MetricCard label="Trend" value={`${stock.trendScore}`} hint="/ 20" />
          <MetricCard label="Sector" value={`${stock.sectorScore}`} hint="/ 15" />
          <MetricCard label="Fundamental" value={`${stock.fundamentalScore}`} hint="/ 25" />
          <MetricCard label="Accumulation" value={`${stock.accumulationScore}`} hint="/ 15" />
        </div>
      </Card>

      <Card title="Raw Model Data">
        <pre className="overflow-x-auto rounded-md border border-zinc-800 bg-[#09090b] p-4 text-xs font-mono text-zinc-400">
          {JSON.stringify(stock.details, null, 2)}
        </pre>
      </Card>
    </div>
  );
}
