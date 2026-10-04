import { notFound } from "next/navigation";
import { z } from "zod";
import { Card } from "@/components/Card";
import { PageHeading } from "@/components/PageHeading";
import { FundamentalPanel } from "@/components/fundamental/FundamentalPanel";
import { getFundamentalPage } from "@/lib/fundamental/store";
import { symbolSchema, type FundamentalPageData } from "@/lib/fundamental/types";
import { loadRuntimeConfig } from "@/lib/runtimeConfig";

export const dynamic = "force-dynamic";
export const metadata = { title: "基本面估值", description: "已保存的基本面情景估值、来源与修订历史。" };

export default async function FundamentalPage({ params, searchParams }: {
  params: Promise<{ symbol: string }>;
  searchParams: Promise<{ entryAt?: string | string[] }>;
}) {
  const [{ symbol: rawSymbol }, query] = await Promise.all([params, searchParams]);
  const symbol = symbolSchema.safeParse(rawSymbol.trim().toUpperCase());
  if (!symbol.success) notFound();
  const entry = query.entryAt === undefined ? null : z.iso.datetime({ offset: true }).safeParse(query.entryAt);
  // This dynamic server page validates against request time; it is never re-rendered on the client.
  // eslint-disable-next-line react-hooks/purity
  if ((entry && !entry.success) || (entry?.success && new Date(entry.data).getTime() > Date.now())) {
    return <Card title="入场时间无效">请提供不晚于当前时间、带时区的完整 ISO 时间；仅有日期无法判断入场时已知信息。</Card>;
  }
  const entryAt = entry?.success ? new Date(entry.data).toISOString() : undefined;
  let data: FundamentalPageData;
  try {
    await loadRuntimeConfig();
    data = await getFundamentalPage(symbol.data, { entryAt });
  } catch {
    data = { symbol: symbol.data, state: null, history: [], atEntry: null, entryAt: entryAt ?? null, error: "估值读取暂不可用" };
  }
  return <div className="space-y-6">
    <PageHeading eyebrow="FUNDAMENTAL VALUATION" title="基本面估值" english={symbol.data} description="关注价值空间，保留每次判断的依据。" />
    <Card><FundamentalPanel data={data} /></Card>
    <a href="/desk" className="inline-flex min-h-11 items-center text-sm text-(--accent) underline underline-offset-4">返回信号台</a>
  </div>;
}
