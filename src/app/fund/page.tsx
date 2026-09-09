import { FundWorkbench } from "@/components/FundWorkbench";

export const dynamic = "force-dynamic";

export default function FundPage() {
  return (
    <div className="space-y-6">
      <div className="rise-in">
        <h1 className="text-3xl font-semibold tracking-tight text-zinc-50">资金账本</h1>
        <p className="mt-2 max-w-3xl text-sm leading-relaxed text-zinc-400">
          按记账池从起点空仓推演 4 小时和 2 小时账本。修改先保留为草稿，保存并重算后更新结果，历史版本可随时查看。
        </p>
      </div>
      <FundWorkbench />
    </div>
  );
}
