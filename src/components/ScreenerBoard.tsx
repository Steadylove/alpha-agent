import { Card } from "@/components/Card";
import type { ScreenerPageData } from "@/lib/dashboard/screener";
import type { ScreenerRow } from "@/lib/jobs/alphaScreener";
import { Stack, Text } from "@mantine/core";

function ScreenerTable({ rows }: { rows: ScreenerRow[] }) {
  if (rows.length === 0) {
    return (
      <Text size="sm" c="dimmed">
        今日无符合条件标的。
      </Text>
    );
  }

  return (
    <div className="overflow-x-auto -mx-1">
      <table className="w-full text-sm whitespace-nowrap">
        <thead>
          <tr>
            <th className="w-10 text-center">#</th>
            <th>Symbol</th>
            <th>Industry</th>
            <th className="text-right">20D</th>
            <th className="text-right">50D</th>
            <th className="text-right">120D</th>
            <th className="text-right">250D</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, idx) => (
            <tr key={row.symbol}>
              <td className="text-center text-zinc-500">{idx + 1}</td>
              <td>
                <div className="font-medium text-zinc-100">{row.symbol}</div>
                <div className="text-xs text-zinc-500">{row.name}</div>
              </td>
              <td className="text-zinc-400">{row.industryLabel}</td>
              <td className="text-right text-emerald-400">{Math.round(row.rps[20])}</td>
              <td className="text-right text-emerald-400">{Math.round(row.rps[50])}</td>
              <td className="text-right text-emerald-400">{Math.round(row.rps[120])}</td>
              <td className="text-right text-emerald-400">{Math.round(row.rps[250])}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ScreenerBoard({ data }: { data: ScreenerPageData }) {
  return (
    <Stack gap="lg">
      <Card
        title={`强势股精英池 · ${data.elite.length} 只`}
        action={
          <Text size="xs" c="dimmed">
            四周期 RPS &gt; {data.baseThreshold}
          </Text>
        }
      >
        <ScreenerTable rows={data.elite} />
      </Card>

      <Card title={`盘中新高趋势发现 · ${data.newHighs.length} 只`}>
        <ScreenerTable rows={data.newHighs} />
      </Card>
    </Stack>
  );
}
