import { StockPanelBoard } from "@/components/StockPanelBoard";
import { getStockPanelData } from "@/lib/dashboard/stockPanel";

export const dynamic = "force-dynamic";

export default async function DepthPage() {
  const data = await getStockPanelData();

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-zinc-50">个股深度面板</h1>
        <span className="text-sm text-zinc-500">形态阶段 · 分形态 · 低吸带</span>
      </div>

      <StockPanelBoard data={data} />
    </div>
  );
}
