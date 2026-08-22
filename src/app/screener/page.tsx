import { Card, MetricCard } from "@/components/Card";
import { getLatestScreenerData } from "@/lib/dashboard/screener";
import { Text } from "@mantine/core";

/** 数据每日一更，按 ISR 缓存；见首页注释。 */
export const revalidate = 300;

export default async function ScreenerPage() {
  const data = await getLatestScreenerData();

  if (!data) {
    return (
      <div className="space-y-6 px-1">
        <h1 className="text-3xl font-semibold tracking-tight text-zinc-50">每日筛选</h1>
        <Card title="数据生成中">
          <Text size="sm" c="dimmed">
            当日的筛选结果还没算出来，请稍后刷新。
          </Text>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6 px-1">
      <div>
        <h1 className="text-3xl font-semibold tracking-tight text-zinc-50">每日筛选</h1>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-zinc-400">
          从全市场找出在 20 / 50 / 120 / 250 日四个周期上同时跑赢
          {data.baseThreshold}% 以上个股的标的——短中长期动能一致向上，说明资金在持续流入。
        </p>
      </div>

      <div className="grid gap-3 grid-cols-2">
        <MetricCard label="扫描股票池" value={String(data.universeSize)} />
        <MetricCard label="四周期共振" value={String(data.elite.length)} valueColor="yellow.4" />
      </div>

      <Card title={`${data.date} · 共 ${data.elite.length} 只`}>
        {data.elite.length === 0 ? (
          <Text size="sm" c="dimmed">
            今日无符合条件标的。
          </Text>
        ) : (
          <div className="space-y-4">
            {data.elite.map((row, idx) => (
              <div
                key={row.symbol}
                className="rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-sunken)] p-3 sm:p-4"
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
