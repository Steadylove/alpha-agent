import { Card } from "@/components/Card";
import { StatusBadge } from "@/components/StatusBadge";
import { getDashboardData } from "@/lib/dashboard/data";
import Link from "next/link";

export default async function StocksPage() {
  const data = await getDashboardData();

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-zinc-50">Alpha Universe</h1>
      </div>

      <Card>
        <div className="overflow-x-auto -mx-4 px-4 sm:mx-0 sm:px-0">
          <table className="w-full text-sm whitespace-nowrap">
            <thead>
              <tr>
                <th className="w-12 text-center">#</th>
                <th>Symbol</th>
                <th className="text-right">Total</th>
                <th className="text-right">RPS</th>
                <th className="text-right">Trend</th>
                <th className="text-right">Sector</th>
                <th className="text-right">Quality</th>
                <th className="text-right">Flow</th>
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
                  <td className="text-right font-medium text-emerald-400">{stock.totalScore}</td>
                  <td className="text-right text-zinc-400">{stock.rpsScore}</td>
                  <td className="text-right text-zinc-400">{stock.trendScore}</td>
                  <td className="text-right text-zinc-400">{stock.sectorScore}</td>
                  <td className="text-right text-zinc-400">{stock.fundamentalScore}</td>
                  <td className="text-right text-zinc-400">{stock.accumulationScore}</td>
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
