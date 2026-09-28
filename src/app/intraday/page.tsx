import { IntradayResearch } from "@/components/intraday/IntradayResearch";
import { getResearchPage } from "@/lib/intraday/researchStore";

export const dynamic = "force-dynamic";
export const metadata = {
	title: "日内策略研究",
	description: "盘前共振信号的历史回放、执行假设与逐笔验证。",
};
export default async function IntradayPage({
	searchParams,
}: {
	searchParams: Promise<{ run?: string }>;
}) {
	const { run } = await searchParams;
	return <IntradayResearch {...await getResearchPage(run)} />;
}
