import { execFileSync } from "node:child_process";
import { mkdirSync, copyFileSync } from "node:fs";
const out = "deploy/market-http";
mkdirSync(`${out}/review-card-assets`, { recursive: true });
execFileSync(process.env.ESBUILD_CLI || "npx", [...(process.env.ESBUILD_CLI ? [] : ["--yes", "esbuild"]), "scripts/push-review-cards.ts", "--bundle", "--platform=node", "--format=esm", `--outfile=${out}/review-cards.mjs`, "--alias:@=./src", "--external:sharp", '--banner:js=import { createRequire as bundleRequire } from "node:module"; const require = bundleRequire(import.meta.url);'], { stdio: "inherit" });
copyFileSync("scripts/fetch-gex-snapshot.py", `${out}/fetch-gex-snapshot.py`);
copyFileSync("src/lib/discord/trendAdaptiveLogo.svg", `${out}/review-card-assets/trendAdaptiveLogo.svg`);
