import { RotationBoard } from "@/components/RotationBoard";
import { RotationNavCurve } from "@/components/RotationNavCurve";
import { RotationSignals } from "@/components/RotationSignals";
import { getRotationData } from "@/lib/dashboard/rotation";

export const dynamic = "force-dynamic";

export default async function RotationPage() {
  const data = await getRotationData();

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-zinc-50">动能满仓轮动雷达</h1>
        <span className="text-sm text-zinc-500">40 只标的 · 日线</span>
      </div>

      <RotationBoard data={data} />

      <RotationNavCurve curve={data.navCurve} maxDrawdownPct={data.maxDrawdownPct} />

      {data.latestDate ? <RotationSignals signals={data.recentSignals} /> : null}
    </div>
  );
}
