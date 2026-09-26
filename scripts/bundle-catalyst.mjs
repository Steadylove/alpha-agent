import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";

mkdirSync("deploy/market-http", { recursive: true });
execFileSync(process.env.ESBUILD_CLI || "npx", [...(process.env.ESBUILD_CLI ? [] : ["--yes", "esbuild"]), "scripts/build-catalyst.ts", "--bundle", "--platform=node", "--format=esm", "--outfile=deploy/market-http/catalyst.mjs", "--alias:@=./src", '--banner:js=import { createRequire as bundleRequire } from "node:module"; const require = bundleRequire(import.meta.url);'], { stdio: "inherit" });
