import { FlowResearchBoard } from "@/components/flow/FlowResearchBoard";
import { getFlowResearchPage } from "@/lib/optionFlow/research/store";

export const dynamic = "force-dynamic";
export const metadata = { title: "异常期权流 · Market Compass", description: "异常期权流的主题分布、相对强度、持续性与后续表现研究。" };
export default async function FlowPage({ searchParams }: { searchParams: Promise<{ date?: string }> }) {
  const { date } = await searchParams;
  return <FlowResearchBoard {...await getFlowResearchPage(date)} />;
}
