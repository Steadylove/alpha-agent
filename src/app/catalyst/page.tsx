import { CatalystMonitor } from "@/components/catalyst/CatalystMonitor";
import { getCatalystPage } from "@/lib/catalyst/store";

export const dynamic = "force-dynamic";
export const metadata = {
  title: "Catalyst Monitor · 事件观察",
  description: "关联持仓、信号与观察标的的现实事件，追踪已发生的市场反应。",
};

export default async function CatalystPage() {
  return <CatalystMonitor {...await getCatalystPage()} />;
}
