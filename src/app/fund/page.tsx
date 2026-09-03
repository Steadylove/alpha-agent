import { FundBoard } from "@/components/FundBoard";

export const dynamic = "force-dynamic";

export default function FundPage() {
  return (
    <div className="space-y-6">
      <div className="rise-in">
        <h1 className="text-3xl font-semibold tracking-tight text-zinc-50">资金账本</h1>
        <p className="mt-2 max-w-3xl text-sm leading-relaxed text-zinc-400">
          记真实成交,按纪律出明日开盘清单。每笔投权益的 12.5%,现金不够就不开;满仓时新信号的
          RPS 要比最弱持仓高出 20 分才置换。吊灯位从实际成交价逐根推出来,与回测同一份口径。
        </p>
      </div>
      <FundBoard />
    </div>
  );
}
