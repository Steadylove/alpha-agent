import { OpportunityBoard } from "@/components/OpportunityBoard";
import { getOpportunityData } from "@/lib/dashboard/opportunity";

export const revalidate = 300;

export default async function OpportunityPage() {
  const data = await getOpportunityData();

  return (
    <div className="space-y-6">
      <div className="rise-in">
        <h1 className="text-3xl font-semibold tracking-tight text-zinc-50">机会</h1>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-zinc-400">
          哪个行业在抬头、截面里谁在变强。现网池只是标记，不是这份名单。改池时看，不改买点，也不改账本。
        </p>
      </div>
      <OpportunityBoard data={data} />
    </div>
  );
}
