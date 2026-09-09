import type { ScreenerResult } from "@/lib/jobs/alphaScreener";
import { readSnapshot } from "@/lib/vps/snapshot";

export type ScreenerPageData = ScreenerResult & {
  date: string;
};

export async function getLatestScreenerData(): Promise<ScreenerPageData | null> {
  return readSnapshot<ScreenerPageData>("screener");
}
