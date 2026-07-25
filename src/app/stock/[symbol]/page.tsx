import { Card, MetricCard } from "@/components/Card";
import { DualTargetCards } from "@/components/DualTargetCards";
import { PriceChart } from "@/components/PriceChart";
import { StockScoreCard } from "@/components/StockScoreCard";
import { getDashboardData } from "@/lib/dashboard/data";
import { getStockChartData } from "@/lib/dashboard/stockChart";
import { notFound } from "next/navigation";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";

export const dynamic = "force-dynamic";

export default async function StockDetailPage({ params }: { params: Promise<{ symbol: string }> }) {
  const { symbol } = await params;
  const upper = symbol.toUpperCase();
  const data = await getDashboardData();
  const stock = data.stocks.find((item) => item.symbol === upper);

  if (!stock) {
    notFound();
  }

  const chartData = process.env.DATABASE_URL
    ? await getStockChartData(upper, stock).catch(() => null)
    : null;

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
        <MetricCard label="Rank" value={`#${stock.rank}`} />
        <MetricCard
          label="Final Compass"
          value={stock.finalCompassScore.toString()}
          valueColor={
            stock.finalCompassScore >= 80 ? "teal.4" :
            stock.finalCompassScore >= 60 ? "cyan.4" :
            stock.finalCompassScore >= 40 ? "yellow.4" : "red.4"
          }
        />
        <MetricCard label="Sector" value={stock.sector} valueColor="cyan.4" />
        <MetricCard label="Status" value={stock.status} valueColor={
          stock.status === 'FOCUS' ? 'emerald.4' :
          stock.status === 'WATCH' ? 'blue.4' :
          stock.status === 'NEW' ? 'amber.4' :
          stock.status === 'DOWNGRADED' ? 'rose.4' : undefined
        } />
      </div>

      <DualTargetCards stock={stock} />

      {chartData ? (
        <PriceChart
          data={chartData}
          tradingTarget60d={typeof stock.details.tradingTarget60d === "number" ? stock.details.tradingTarget60d : null}
        />
      ) : null}

      <StockScoreCard stock={stock} />

      <Card title="Raw Model Data">
        <pre className="overflow-x-auto rounded-md border border-zinc-800 bg-[#09090b] p-4 text-xs font-mono text-zinc-400">
          {JSON.stringify(stock.details, null, 2)}
        </pre>
      </Card>
    </div>
  );
}
