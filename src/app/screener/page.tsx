import { Card, MetricCard } from "@/components/Card";
import { getLatestScreenerData } from "@/lib/dashboard/screener";
import { Text } from "@mantine/core";

export const dynamic = "force-dynamic";

export default async function ScreenerPage() {
  const data = await getLatestScreenerData();

  if (!data) {
    return (
      <div className="space-y-6 px-1">
        <h1 className="text-2xl font-semibold text-zinc-50">每日 RPS 筛选</h1>
        <Card title="暂无数据">
          <Text size="sm" c="dimmed">
            还没有落库结果。请先触发：
          </Text>
          <Text size="xs" c="dimmed" mt="sm" ff="monospace">
            POST /api/jobs/alpha-screener
          </Text>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6 px-1">
      <div>
        <h1 className="text-2xl font-semibold text-zinc-50">每日 RPS 筛选</h1>
        <Text size="sm" c="dimmed" mt={4}>
          日期 {data.date} · 四周期 RPS 均 &gt; {data.baseThreshold}
        </Text>
      </div>

      <div className="grid gap-3 grid-cols-3">
        <MetricCard label="股票池" value={String(data.universeSize)} />
        <MetricCard
          label={`命中 >${data.baseThreshold}`}
          value={String(data.elite.length)}
          valueColor="yellow.4"
        />
        <MetricCard
          label="日线失败"
          value={String(data.dailyFetchErrors)}
          valueColor={data.dailyFetchErrors > 0 ? "yellow.4" : "teal.4"}
        />
      </div>

      <Card title={`四周期共振 · ${data.elite.length} 只`}>
        {data.elite.length === 0 ? (
          <Text size="sm" c="dimmed">
            今日无符合条件标的。
          </Text>
        ) : (
          <div className="space-y-4">
            {data.elite.map((row, idx) => (
              <div
                key={row.symbol}
                className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-3 sm:p-4"
              >
                <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                  <Text size="xs" c="dimmed">
                    {idx + 1}.
                  </Text>
                  <Text fw={700} c="zinc.1" size="lg">
                    {row.symbol}
                  </Text>
                  <Text size="sm" c="dimmed" className="break-all">
                    {row.name}
                  </Text>
                </div>
                <Text size="sm" c="yellow.4" mt={6}>
                  {row.industryLabel ?? [row.sector, row.industry].filter(Boolean).join("｜")}
                </Text>
                <div className="mt-2 grid grid-cols-2 gap-1 sm:grid-cols-4">
                  {(
                    [
                      [20, row.rps[20]],
                      [50, row.rps[50]],
                      [120, row.rps[120]],
                      [250, row.rps[250]],
                    ] as const
                  ).map(([w, v]) => (
                    <Text key={w} size="xs" c="dimmed">
                      {w}日 <span className="text-zinc-200">{v.toFixed(0)}</span>
                    </Text>
                  ))}
                </div>
                <Text size="sm" c="gray.4" mt={6}>
                  {row.blurb}
                </Text>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
