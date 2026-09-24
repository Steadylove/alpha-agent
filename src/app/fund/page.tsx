import { PageHeading } from "@/components/PageHeading";
import { FundWorkbench } from "@/components/FundWorkbench";

export const metadata = { title: "资金账本" };

export const dynamic = "force-dynamic";

export default function FundPage() {
  return (
    <div className="space-y-6">
      <PageHeading
        eyebrow="STRATEGY ACCOUNTS"
        title="资金账本"
        english="Strategy accounts"
        description="4 小时和 2 小时账本分别连续记账，可在各自周期下选择日期重新开账。改池只影响保存后新开始的 K 线，已有持仓与累计成绩继续保留。"
      />
      <FundWorkbench />
    </div>
  );
}
