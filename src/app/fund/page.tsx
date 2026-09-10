import { FundWorkbench } from "@/components/FundWorkbench";

export const dynamic = "force-dynamic";

export default function FundPage() {
  return (
    <div className="space-y-6">
      <div className="rise-in">
        <h1 className="text-3xl font-semibold tracking-tight text-zinc-50">资金账本</h1>
        <p className="mt-2 max-w-3xl text-sm leading-relaxed text-zinc-400">
          4 小时和 2 小时账本分别连续记账，可在各自周期下选择日期重新开账。改池只影响保存后新开始的 K 线，已有持仓与累计成绩继续保留。
        </p>
      </div>
      <FundWorkbench />
    </div>
  );
}
