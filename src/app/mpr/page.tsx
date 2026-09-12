import { MprPanel } from "@/components/MprPanel";
import { MprTimeline } from "@/components/MprTimeline";
import { getMprData } from "@/lib/dashboard/mpr";

/** 数据每日一更，按 ISR 缓存；见首页注释。 */
export const revalidate = 300;

export default async function MprPage() {
  const data = await getMprData();

  return (
    <div className="space-y-6">
      <div className="rise-in">
        <h1 className="text-3xl font-semibold tracking-tight text-zinc-50">市场相变雷达</h1>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-zinc-400">
          从五个维度看衍生品、信用、现货紧不紧。路径是区制标签，不预测涨跌，也不给仓位。
        </p>
      </div>

      <MprPanel data={data} />

      <MprTimeline history={data.history} />
    </div>
  );
}
