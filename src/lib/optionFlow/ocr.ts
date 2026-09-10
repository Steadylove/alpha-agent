import { spawnSync } from "node:child_process";

import { ocrImageFile as ocrMac } from "./ocrMac";

function hasBin(name: string): boolean {
  return spawnSync("which", [name], { encoding: "utf8" }).status === 0;
}

function ocrTesseract(file: string): string {
  const result = spawnSync("tesseract", [file, "stdout", "--psm", "6"], {
    encoding: "utf8",
    maxBuffer: 2 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(result.stderr.trim() || "tesseract 失败");
  return result.stdout;
}

export function ocrImageFile(file: string): string {
  if (hasBin("tesseract")) return ocrTesseract(file);
  if (process.platform === "darwin") return ocrMac(file);
  throw new Error("没有可用的 OCR（需要 tesseract 或 macOS Vision）");
}
