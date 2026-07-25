import { Card } from "@/components/Card";
import { KillSwitchList } from "@/components/KillSwitchList";
import { StatusBadge } from "@/components/StatusBadge";
import { getDashboardData } from "@/lib/dashboard/data";
import Link from "next/link";

export const dynamic = "force-dynamic";

export default async function StocksPage() {
  const data = await getDashboardData();

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-zinc-50">Alpha Universe</h1>
      </div>

      <KillSwitchList
        total={data.killSwitchSummary.total}
        blocked={data.killSwitchSummary.blocked}
      />

      <Card>
        <div className="overflow-x-auto -mx-4 px-4 sm:mx-0 sm:px-0">
          <table className="w-full text-sm whitespace-nowrap">
            <thead>
              <tr>
                <th className="w-12 text-center">#</th>
                <th>Symbol</th>
                <th className="text-right">Final</th>
                <th className="text-right">Quality/50</th>
                <th className="text-right">Mom/15</th>
                <th className="text-right">Trend/10</th>
                <th className="text-right">Fund/25</th>
                <th className="text-right">Val/20</th>
                <th className="text-right">Env/15</th>
                <th className="text-right">Exec/15</th>
                <th className="text-right">Kill</th>
                <th className="text-right">Status</th>
              </tr>
            </thead>
            <tbody>
              {data.stocks.map((stock) => (
                <tr key={stock.symbol}>
                  <td className="text-center text-zinc-500">{stock.rank}</td>
                  <td>
                    <Link href={`/stock/${stock.symbol}`} className="font-medium text-zinc-200 hover:underline">
                      {stock.symbol}
                    </Link>
                    <div className="text-xs text-zinc-500">{stock.name}</div>
                  </td>
                  <td className="text-right font-medium text-emerald-400">{stock.finalCompassScore}</td>
                  <td className="text-right text-zinc-400">{stock.qualityScore}</td>
                  <td className="text-right text-zinc-400">{stock.momentumScore}</td>
                  <td className="text-right text-zinc-400">{stock.trendScore}</td>
                  <td className="text-right text-zinc-400">{stock.fundamentalScore}</td>
                  <td className="text-right text-zinc-400">{stock.valuationScore}</td>
                  <td className="text-right text-zinc-400">{stock.environmentScore}</td>
                  <td className="text-right text-zinc-400">{stock.executionScore}</td>
                  <td className="text-right text-xs">
                    {stock.killSwitchStatus === "PASSED" ? (
                      <span className="text-emerald-400">🟢</span>
                    ) : (
                      <span className="text-red-400" title={stock.killSwitchReason ?? ""}>⛔</span>
                    )}
                  </td>
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
  );
}
