import { pickLookbackPool } from "@/lib/fund/lookbackPick";

async function main() {
  const from = process.argv[2] ?? "2026-01-01";
  const n = Number(process.argv[3] ?? 40);
  const picked = await pickLookbackPool(from, n, "both");
  console.log(`有交易 ${picked.scored}  选出 ${picked.members.length}`);
  console.log(picked.members.join(" "));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
