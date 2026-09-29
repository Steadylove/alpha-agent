import { build } from "esbuild";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const out = path.resolve(process.env.RUNTIME_OUTPUT || "dist/runtime");
const revision = process.env.RELEASE_ID || "local";
if (!/^[a-z0-9-]{5,80}$/.test(revision)) throw new Error("Invalid release ID");
rmSync(out, { recursive: true, force: true });
mkdirSync(path.join(out, "jobs"), { recursive: true });
const banner = { js: 'import { createRequire as bundleRequire } from "node:module"; const require = bundleRequire(import.meta.url);' };
const common = { bundle: true, platform: "node", format: "esm", target: "node22", alias: { "@": "./src", "next/og": "next/og.js" }, banner, logLevel: "warning" };
const jobs = ["refresh-market-csv", "run-daily-jobs", "build-flow-research", "check-daily-review", "build-daily-review", "push-gex-card", "push-daily-screener", "build-review-analysis", "build-catalyst", "supplement-review-macro", "push-review-cards"];
for (const job of jobs) {
  await build({ ...common, packages: "external", entryPoints: [`scripts/${job}.ts`], outfile: path.join(out, `jobs/${job}.mjs`) });
}
for (const [name, entry] of Object.entries({ compute: "book-worker", telegram: "telegram-worker", "option-flow": "option-flow-worker" })) {
  await build({ ...common, entryPoints: [`scripts/${entry}.ts`], external: ["sharp", "dotenv"], outfile: path.join(out, `${name}.mjs`) });
}
for (const file of ["docker-compose.yml", "nginx.conf.template", "desk-http.mjs", "verify-runtime.mjs"]) cpSync(`deploy/market-http/${file}`, path.join(out, file));
cpSync("deploy/market-http/cron", path.join(out, "cron"), { recursive: true });
cpSync("scripts/fetch-gex-snapshot.py", path.join(out, "fetch-gex-snapshot.py"));
cpSync("package.json", path.join(out, "package.json"));
cpSync("package-lock.json", path.join(out, "package-lock.json"));
mkdirSync(path.join(out, "review-card-assets"));
cpSync("src/lib/discord/trendAdaptiveLogo.svg", path.join(out, "review-card-assets/trendAdaptiveLogo.svg"));
writeFileSync(path.join(out, "fontconfig.conf"), `<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd">
<fontconfig><dir prefix="relative">fonts</dir><cachedir>/tmp/alpha-font-cache</cachedir>
<alias><family>Noto Sans SC</family><prefer><family>Noto Sans CJK SC</family></prefer></alias>
<alias><family>sans-serif</family><prefer><family>Noto Sans CJK SC</family></prefer></alias></fontconfig>\n`);
const files = {};
function inventory(dir) {
  for (const item of readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, item.name);
    if (item.isDirectory()) inventory(file);
    else files[path.relative(out, file)] = createHash("sha256").update(readFileSync(file)).digest("hex");
  }
}
inventory(out);
writeFileSync(path.join(out, "runtime.json"), JSON.stringify({ version: 1, revision, nodeMajor: 22, platform: process.platform, arch: process.arch, jobs, files }, null, 2));
console.log(`Prepared ${jobs.length} jobs and 3 services: ${out} (${revision})`);
