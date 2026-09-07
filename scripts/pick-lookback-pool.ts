import { pickLookbackPool } from "@/lib/fund/lookbackPick";
import { isLookbackPickTf } from "@/lib/fund/lookbackPickLogic";

async function main() {
  const from = process.argv[2] ?? "2026-01-01";
  const n = Number(process.argv[3] ?? 10);
  const tfRaw = process.argv[4] ?? "4h";
  if (!isLookbackPickTf(tfRaw) || tfRaw === "both") {
    throw new Error("tf 必须是 4h 或 2h");
  }
  const picked = await pickLookbackPool(from, n, tfRaw);
  console.log(`${tfRaw}  有交易 ${picked.scored}  选出 ${picked.members.length}`);
  console.log(picked.members.join(" "));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
