import { FundWorkbench } from "@/components/FundWorkbench";

export const dynamic = "force-dynamic";

export default function FundPage() {
  return (
    <div className="space-y-6">
      <div className="rise-in">
        <h1 className="text-3xl font-semibold tracking-tight text-zinc-50">资金账本</h1>
        <p className="mt-2 max-w-3xl text-sm leading-relaxed text-zinc-400">
          当前应用读日推算好的 4 小时和 2H 扩池账本，和 Discord 同一口径。改池、改起点或等下次行情日推才会更新；也可以手动重算。
        </p>
      </div>
      <FundWorkbench />
    </div>
  );
}
