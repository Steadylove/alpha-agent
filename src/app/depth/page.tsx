import { StockPanelBoard } from "@/components/StockPanelBoard";
import { getStockPanelData } from "@/lib/dashboard/stockPanel";

/** 数据每日一更，按 ISR 缓存；见首页注释。 */
export const revalidate = 300;

export default async function DepthPage() {
  const data = await getStockPanelData();

  return (
    <div className="space-y-6">
      <div className="rise-in">
        <h1 className="text-3xl font-semibold tracking-tight text-zinc-50">个股深度面板</h1>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-zinc-400">
          逐只给出今天的操作建议，并说明理由：它处在什么形态、行业是否在风口、
          回踩到哪个价位值得接。点代码可看 K 线上的历史买卖点与止损轨迹。
        </p>
      </div>

      <StockPanelBoard data={data} />
    </div>
  );
}
