import { FlowResearchBoard } from "@/components/flow/FlowResearchBoard";
import { getContextReport } from "@/lib/context/store";
import { getFlowResearchPage } from "@/lib/optionFlow/research/store";

export const dynamic = "force-dynamic";
export const metadata = { title: "异常期权流", description: "异常期权流的主题分布、相对强度、持续性与后续表现研究。" };
export default async function FlowPage({ searchParams }: { searchParams: Promise<{ date?: string }> }) {
  const { date } = await searchParams;
  const page = await getFlowResearchPage(date);
  const context = page.report ? await getContextReport(page.report.date) : null;
  return <FlowResearchBoard {...page} context={context} />;
}
