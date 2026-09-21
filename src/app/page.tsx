import { DailyReview } from "@/components/review/DailyReview";
import { getReviewData } from "@/lib/review/store";

export const dynamic = "force-dynamic";
export const metadata = {
  title: "每日复盘 · Market Compass",
  description: "市场状态、期权结构、板块轮动、买点留档与系统事后验证。",
};

export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<{ date?: string }>;
}) {
  const { date } = await searchParams;
  return <DailyReview {...await getReviewData(date)} />;
}
