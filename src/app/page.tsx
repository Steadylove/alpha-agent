import { Card, MetricCard } from "@/components/Card";
import { StatusBadge } from "@/components/StatusBadge";
import { getDashboardData } from "@/lib/dashboard/data";
import Link from "next/link";
import { ArrowRight } from "lucide-react";

export default async function DashboardPage() {
  const data = await getDashboardData();
  const mss = data.report.summary.match(/MSS (\d+)\/100/)?.[1] ?? "N/A";

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-zinc-50">Overview</h1>
        <Link
          href={`/reports/${data.report.date}`}
          className="inline-flex items-center gap-2 text-sm text-zinc-400 hover:text-zinc-50 transition-colors"
        >
          Latest Report <ArrowRight className="h-4 w-4" />
        </Link>
      </div>

      <div className="grid gap-4 md:grid-cols-4">
        <MetricCard label="Market Safety Score" value={`${mss}`} hint="Macro risk & breadth" valueColor="blue.4" />
        <MetricCard label="Leading Sector" value={data.sectors[0]?.name ?? "N/A"} hint={data.sectors[0]?.symbol} valueColor="cyan.4" />
        <MetricCard label="Top Candidate" value={data.stocks[0]?.symbol ?? "N/A"} hint={data.stocks[0]?.name} valueColor="teal.4" />
        <MetricCard
          label="Kill Switch 通过率"
          value={
            data.killSwitchSummary.total > 0
              ? `${Math.round(((data.killSwitchSummary.total - data.killSwitchSummary.blocked.length) / data.killSwitchSummary.total) * 100)}%`
              : "N/A"
          }
          hint={
            data.killSwitchSummary.blocked.length > 0
              ? `${data.killSwitchSummary.blocked.length} 只熔断`
              : "全部通过 6 条量化熔断"
          }
          valueColor={
            data.killSwitchSummary.blocked.length === 0
              ? "teal.4"
              : data.killSwitchSummary.blocked.length <= 3
                ? "yellow.4"
                : "red.4"
          }
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Sector Leadership">
          <div className="overflow-x-auto -mx-4 px-4 sm:mx-0 sm:px-0">
            <table className="w-full text-sm">
              <thead>
                <tr>
                  <th>Sector</th>
                  <th className="text-right">Score</th>
                  <th className="text-right">21D</th>
                  <th className="text-right">63D</th>
                </tr>
              </thead>
              <tbody>
                {data.sectors.slice(0, 5).map((sector) => (
                  <tr key={sector.symbol} className="group">
                    <td className="py-2">
                      <div className="font-medium text-zinc-200">{sector.name}</div>
                      <div className="text-xs text-zinc-500">{sector.symbol}</div>
                    </td>
                    <td className="text-right font-medium text-sky-400">{sector.score}</td>
                    <td className="text-right text-zinc-400">{(sector.rs21 * 100).toFixed(1)}%</td>
                    <td className="text-right text-zinc-400">{(sector.rs63 * 100).toFixed(1)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        <Card title="Alpha Universe">
          <div className="overflow-x-auto -mx-4 px-4 sm:mx-0 sm:px-0">
            <table className="w-full text-sm">
              <thead>
                <tr>
                  <th>Symbol</th>
                  <th className="text-right">Final</th>
                  <th className="text-right">Quality</th>
                  <th className="text-right">Status</th>
                </tr>
              </thead>
              <tbody>
                {data.stocks.slice(0, 5).map((stock) => (
                  <tr key={stock.symbol} className="group">
                    <td className="py-2">
                      <Link href={`/stock/${stock.symbol}`} className="font-medium text-zinc-200 hover:underline">
                        {stock.symbol}
                      </Link>
                      <div className="text-xs text-zinc-500">{stock.name}</div>
                    </td>
                    <td className="text-right font-medium text-emerald-400">{stock.finalCompassScore}</td>
                    <td className="text-right text-zinc-400">{stock.qualityScore}</td>
                    <td className="text-right">
                      <StatusBadge status={stock.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      </div>
    </div>
  );
}
