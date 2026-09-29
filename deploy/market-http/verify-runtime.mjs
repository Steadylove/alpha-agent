// Safe preflight: parse code and render locally; never import job entrypoints or send notifications.
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(path.join(root, "runtime.json"), "utf8"));
if (manifest.version !== 1 || manifest.nodeMajor !== Number(process.versions.node.split(".")[0]) || manifest.arch !== process.arch || manifest.platform !== process.platform) throw new Error("Runtime platform / Node version mismatch");
if (process.argv[2] && manifest.revision !== process.argv[2]) throw new Error("Runtime revision mismatch");
for (const [name, hash] of Object.entries(manifest.files)) {
  if (path.isAbsolute(name) || name.split(/[\\/]/).includes("..")) throw new Error("Invalid manifest path");
  const file = path.join(root, name);
  if (createHash("sha256").update(readFileSync(file)).digest("hex") !== hash) throw new Error(`Runtime checksum failed: ${name}`);
  if (name.endsWith(".mjs")) execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
}
for (const name of ["NotoSansCJK-Regular.ttc", "NotoSansCJK-Bold.ttc"]) if (!existsSync(path.join(root, "fonts", name))) throw new Error("Runtime font missing");
const require = createRequire(path.join(root, "package.json"));
for (const name of ["next/og", "dotenv", "zod", "sharp", "@vercel/oidc", "jose"]) require.resolve(name);
process.env.FONTCONFIG_FILE = path.join(root, "fontconfig.conf");
const sharp = require("sharp");
const png = await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="80" height="30"><text x="0" y="20" font-family="Noto Sans CJK SC">复盘</text></svg>')).png().toBuffer();
if (png.length < 100) throw new Error("Native image smoke test failed");
const { ImageResponse } = await import("next/og.js");
const og = await new ImageResponse({ type: "div", props: { children: "runtime" } }, { width: 80, height: 30 }).arrayBuffer();
if (og.byteLength < 100) throw new Error("OG image smoke test failed");
console.log(JSON.stringify({ ok: true, revision: manifest.revision, jobs: manifest.jobs.length, nativeImageBytes: png.length }));
