/**
 * 行情目录打包 / 解包。布局固定为 1d 4h 2h 1h rps，整包搬走即可。
 *
 *   npm run market:pack
 *   npm run market:unpack -- /path/to/alpha-market-20260906.tar.gz
 *
 * 服务器上推荐 MARKET_DATA_DIR=/var/lib/alpha-agent/market
 */

import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { localSourceLayout, marketDataRoot, writeManifest } from "@/lib/backtest/marketStore";

const SERVER_ROOT = "/var/lib/alpha-agent/market";

function stamp() {
  return new Date().toISOString().slice(0, 10).replaceAll("-", "");
}

function runTar(args: string[]): void {
  const result = spawnSync("tar", args, { stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`tar ${args.join(" ")} 失败`);
  }
}

function stageCanonical(stage: string): void {
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(path.join(stage, "rps"), { recursive: true });
  for (const { dest, src } of localSourceLayout()) {
    if (!existsSync(src)) continue;
    const target = path.join(stage, dest);
    mkdirSync(path.dirname(target), { recursive: true });
    cpSync(src, target, { recursive: true });
  }
  writeManifest(stage);
}

function pack(outFile?: string): string {
  const root = marketDataRoot();
  const out =
    outFile ??
    path.join(root ?? process.cwd(), `alpha-market-${stamp()}.tar.gz`);
  mkdirSync(path.dirname(out), { recursive: true });

  if (root) {
    writeManifest(root);
    runTar(["-C", root, "-czf", out, "1d", "4h", "2h", "1h", "rps", "MANIFEST.json"]);
    return out;
  }

  const stage = path.join(tmpdir(), `alpha-market-pack-${process.pid}`);
  try {
    stageCanonical(stage);
    runTar(["-C", stage, "-czf", out, "1d", "4h", "2h", "1h", "rps", "MANIFEST.json"]);
    return out;
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

function unpack(archive: string, dest?: string): string {
  if (!archive || !existsSync(archive)) {
    throw new Error("用法: npm run market:unpack -- <archive.tar.gz> [dest]");
  }
  const target = dest ?? marketDataRoot() ?? SERVER_ROOT;
  mkdirSync(target, { recursive: true });
  runTar(["-C", target, "-xzf", archive]);
  writeManifest(target);
  return target;
}

function manifestOnly(root?: string): void {
  const dir = root ?? marketDataRoot();
  if (!dir) {
    throw new Error("先设 MARKET_DATA_DIR，或传入目录。");
  }
  console.log(JSON.stringify(writeManifest(dir), null, 2));
}

const [cmd, a, b] = process.argv.slice(2);
if (cmd === "pack") {
  const file = pack(a);
  console.log(`packed ${file}`);
} else if (cmd === "unpack") {
  const dest = unpack(a, b);
  console.log(`unpacked → ${dest}`);
} else if (cmd === "manifest") {
  manifestOnly(a);
} else {
  console.error("用法: market-archive.ts pack|unpack|manifest");
  process.exitCode = 1;
}
