import { RotationBoard } from "@/components/RotationBoard";
import { RotationNavCurve } from "@/components/RotationNavCurve";
import { RotationSignals } from "@/components/RotationSignals";
import { getRotationData } from "@/lib/dashboard/rotation";

export const dynamic = "force-dynamic";

export default async function RotationPage() {
  const data = await getRotationData();

  return (
    <div className="space-y-6">
      <div className="rise-in">
        <h1 className="text-3xl font-semibold tracking-tight text-zinc-50">动能轮动雷达</h1>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-zinc-400">
          在 40 只标的里挑出动能最强的持有，按相对强度分配仓位，靠移动止损控制回撤。
          下面是当前持仓、每只的防线价位，以及年内的净值走势。
        </p>
      </div>

      <RotationBoard data={data} />

      <RotationNavCurve curve={data.navCurve} maxDrawdownPct={data.maxDrawdownPct} />

      {data.latestDate ? <RotationSignals signals={data.recentSignals} /> : null}
    </div>
  );
}
