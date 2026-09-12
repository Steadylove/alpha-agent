import { emptyOpportunity, type OpportunityData } from "@/lib/opportunity/types";
import { readSnapshot } from "@/lib/vps/snapshot";

export async function getOpportunityData(): Promise<OpportunityData> {
  return (await readSnapshot<OpportunityData>("opportunity")) ?? emptyOpportunity();
}
