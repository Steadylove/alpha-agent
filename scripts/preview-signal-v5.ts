/** 历史预览：只读已核验买点和日线缓存，不访问交易/消息接口。 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, basename } from "node:path";
import assert from "node:assert/strict";
import type { PanelBars } from "@/lib/backtest/panel";
import { buildSectorSnapshot, type SectorMember } from "@/lib/signals/sectorFactor";
import { VERIFIED_SECTOR_CLASSIFICATIONS } from "@/lib/signals/sectorClassification";
import { candidateAssessmentOf, candidatePreviewView } from "@/lib/signals/candidateAssessment";
import { buildAlertView, type AlertPayload, type AlertView } from "@/lib/discord/tvAlertCopy";
import { renderSignalOgPng } from "@/lib/discord/signalCardOg";
import { signalCardSvg } from "@/lib/discord/signalCardImage";

async function main() {
const [sectorFile, outputDir, ...files] = process.argv.slice(2);
assert(sectorFile && outputDir && files.length, "用法: tsx scripts/preview-signal-v5.ts <板块行情JSON> <输出目录> <已核验买点JSON...>");
const sectorText = readFileSync(sectorFile, "utf8");
const input = JSON.parse(sectorText) as { source: string; fetchedAt: string; membershipAsOf: string; members: SectorMember[];
  panels: { ticker: string; dates: string[]; close: number[] }[] };
const panels: PanelBars[] = input.panels.map(p => ({ ...p, close: Float32Array.from(p.close),
  high: new Float32Array(), low: new Float32Array(), volume: null, open: null }));
const out = resolve(outputDir); mkdirSync(out, { recursive: true });
const manifest = [];
for (const file of files) {
  const sourceText = readFileSync(file, "utf8");
  const saved = JSON.parse(sourceText) as { payload: AlertPayload; view: AlertView; audit: { rankingAsOf: string; latestSignalRechecked?: boolean; source: string } };
  const { payload, audit } = saved;
  assert.equal(payload.event, "buy");
  assert(audit.latestSignalRechecked, "必须传入已经过策略引擎及真实分钟行情核验的买点");
  const sector = buildSectorSnapshot(panels, input.members, audit.rankingAsOf, {
    generatedAt: input.fetchedAt, membershipAsOf: input.membershipAsOf, membershipSource: input.source,
  });
  for (const [symbol, verified] of Object.entries(VERIFIED_SECTOR_CLASSIFICATIONS)) if (!sector.classification[symbol]) {
    sector.classification[symbol] = verified.id;
    (sector.classificationEvidence ??= {})[symbol] = { asOf: verified.verifiedAt, source: verified.source };
  }
  const candidate = candidateAssessmentOf(payload, saved.view.rps, { sector, asOf: audit.rankingAsOf, replay: true });
  assert(candidate.position.points != null, "位置资料不齐");
  assert(candidate.raw.volume.cvd.points != null && candidate.raw.volume.profile.points != null, "分钟指标资料不齐");
  const view = candidatePreviewView(buildAlertView(payload, saved.view.tfLabel, saved.view.rps), candidate);
  view.rpsEvidence = saved.view.rpsEvidence;
  view.footer = `历史真实买点 · 板块行情截至 ${audit.rankingAsOf} · 成分按 ${input.membershipAsOf} 重建`;
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(payload.barTime);
  const name = `${payload.symbol}-buy-${date}-v5`;
  writeFileSync(resolve(out, `${name}.svg`), signalCardSvg(view));
  writeFileSync(resolve(out, `${name}.png`), await renderSignalOgPng(view));
  writeFileSync(resolve(out, `${name}.json`), JSON.stringify({ payload, view, candidate, audit: { ...audit,
    mode: "historical-reconstruction-not-point-in-time-validation", membershipAsOf: input.membershipAsOf,
    membershipSource: input.source, classificationOverrides: VERIFIED_SECTOR_CLASSIFICATIONS,
    sourceFile: basename(file), sourceSha256: createHash("sha256").update(sourceText).digest("hex"),
    sectorInputSha256: createHash("sha256").update(sectorText).digest("hex"),
    caveat: "行情截止信号时点；板块名单为事后取得。用于展示，不作为无幸存者偏差的样本外业绩。" } }, null, 2));
  const summary = { symbol: payload.symbol, date, price: payload.price, v4: candidate.baseline.points,
    v5: candidate.quality.points, available: candidate.quality.available, position: candidate.position,
    sector: candidate.sector, file: resolve(out, `${name}.png`) };
  manifest.push(summary); console.log(JSON.stringify(summary));
}
writeFileSync(resolve(out, "manifest.json"), JSON.stringify(manifest, null, 2));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
