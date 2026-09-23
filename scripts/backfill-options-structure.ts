import path from "node:path";
import { backfillOptionsStructures } from "../src/lib/review/backfillOptions";

const args = process.argv.slice(2);
const rootIndex = args.indexOf("--root");
const root = rootIndex >= 0 ? args[rootIndex + 1] : undefined;
if (!root || root.startsWith("--"))
  throw new Error(
    "Usage: backfill-options-structure.ts --root <market-data-directory> [--write]",
  );
console.log(
  JSON.stringify(
    backfillOptionsStructures(path.resolve(root), args.includes("--write")),
    null,
    2,
  ),
);
