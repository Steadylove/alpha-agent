import { isEarlyBreakevenCondition } from "@/lib/config/commercialSpec";
import type { MprData } from "@/lib/dashboard/mpr";
import { readSnapshot } from "@/lib/vps/snapshot";

export async function loadEarlyBreakevenDates(): Promise<Set<string>> {
  const mpr = await readSnapshot<MprData>("mpr");
  return new Set(
    (mpr?.history ?? [])
      .filter((r) => isEarlyBreakevenCondition(r.pathId, r.prob5dDown))
      .map((r) => r.date),
  );
}
