import "./load-env";

import { buildAndStoreRpsScale } from "@/lib/backtest/buildRpsScale";

buildAndStoreRpsScale().catch((e) => {
  console.error(e);
  process.exit(1);
});
