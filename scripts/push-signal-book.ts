import "dotenv/config";

import { pushSignalBooks } from "@/lib/fund/pushSignalBook";

async function main() {
  const result = await pushSignalBooks({
    test: process.argv.includes("--test"),
    lookback: process.argv.includes("--lookback"),
  });
  for (const line of result.sent) console.log(line);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
