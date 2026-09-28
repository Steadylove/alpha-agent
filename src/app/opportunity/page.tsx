import { loadRuntimeConfig } from "@/lib/runtimeConfig";
import { PageHeading } from "@/components/PageHeading";
import { OpportunityBoard } from "@/components/OpportunityBoard";
import { getOpportunityData } from "@/lib/dashboard/opportunity";

export const metadata = { title: "机会" };

// Private configuration uses the request's Vercel identity, never a build-time token.
export const dynamic = "force-dynamic";

export default async function OpportunityPage() {
  await loadRuntimeConfig();
  const data = await getOpportunityData();

  return (
    <div className="space-y-6">
      <PageHeading
        eyebrow="SECTOR & STRENGTH"
        title="机会"
        english="Opportunity"
        description="哪个行业在抬头、截面里谁在变强。现网池只是标记，不是这份名单。改池时看，不改买点，也不改账本。"
      />
      <OpportunityBoard data={data} />
    </div>
  );
}
