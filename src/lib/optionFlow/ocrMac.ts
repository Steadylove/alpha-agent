import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";

function binPath(): string {
  return path.join(/*turbopackIgnore: true*/ process.cwd(), ".tmp", "ocr-mac");
}

function sourcePath(): string {
  return path.join(/*turbopackIgnore: true*/ process.cwd(), "scripts", "ocr-mac.swift");
}

function ensureBin(): string {
  const bin = binPath();
  if (existsSync(bin)) return bin;
  if (process.platform !== "darwin") throw new Error("图表 OCR 目前只在 macOS 上跑");
  mkdirSync(path.dirname(bin), { recursive: true });
  const compiled = spawnSync("swiftc", ["-O", sourcePath(), "-o", bin], { encoding: "utf8" });
  if (compiled.status !== 0) throw new Error(compiled.stderr.trim() || "编译 OCR 失败");
  return bin;
}

export function ocrImageFile(file: string): string {
  const result = spawnSync(ensureBin(), [file], { encoding: "utf8", maxBuffer: 2 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(result.stderr.trim() || "OCR 失败");
  return result.stdout;
}
