import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { marketBaseUrl } from "@/lib/backtest/marketStore";
import type { ResearchIndex, ResearchReport } from "./researchTypes";

export const validRunId = (id: string) => /^[a-zA-Z0-9_-]{1,120}$/.test(id);
async function readArtifact<T>(name: string): Promise<T | null> {
  // Local research is intentionally independent of the production snapshots.
  const file = path.join(/*turbopackIgnore: true*/ process.cwd(), "data/intraday-research/reports", name);
  if (!process.env.VERCEL && existsSync(file)) return JSON.parse(readFileSync(file, "utf8"));
  if (!process.env.VERCEL && name.endsWith(".page.json")) {
    const full = file.replace(/\.page\.json$/, ".json");
    if (existsSync(full)) {
      const report = JSON.parse(readFileSync(full, "utf8")) as ResearchReport;
      return { ...report, events: report.events.slice(0, 500) } as T;
    }
  }
  const base = marketBaseUrl();
  if (!base) return null;
  const options = { cache: "no-store" as const, signal: AbortSignal.timeout(45000) };
  // Compressed immutable artifacts avoid transferring a large raw signal journal on every view.
  if (name !== "index.json") {
    const compressed = await fetch(`${base}/snapshots/intraday/${name}.gz`, options);
    if (compressed.ok) {
      const bytes = Buffer.from(await compressed.arrayBuffer());
      return JSON.parse((bytes[0]===0x1f&&bytes[1]===0x8b?gunzipSync(bytes):bytes).toString());
    }
    if (compressed.status !== 404) throw new Error(`研究数据服务返回 ${compressed.status}`);
  }
  const response = await fetch(`${base}/snapshots/intraday/${name}`, options);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`研究数据服务返回 ${response.status}`);
  return response.json();
}
export async function readResearchReport(id: string, preview = false) {
  if (!validRunId(id)) throw new Error("无效研究版本");
  const report = preview ? await readArtifact<ResearchReport>(`${id}.page.json`) ?? await readArtifact<ResearchReport>(`${id}.json`) : await readArtifact<ResearchReport>(`${id}.json`);
  if (report && (report.version !== 1 || report.id !== id || !Array.isArray(report.events) || !Array.isArray(report.scenarios))) throw new Error("研究报告格式不匹配");
  return report;
}
export async function getResearchPage(id?: string) {
  const empty = { report: null, runs: [], error: null } as { report: ResearchReport | null; runs: ResearchIndex["runs"]; error: string | null };
  try {
    if (id && !validRunId(id)) return { ...empty, error: "研究版本无效，请重新选择。" };
    const index = await readArtifact<ResearchIndex>("index.json");
    if (!index) return empty;
    if (index.version !== 1 || !Array.isArray(index.runs)) throw new Error("研究目录格式不匹配");
    // Keep previous versions addressable; selector defaults to the newest per date/profile.
    const keys = new Set<string>();
    const runs = [...index.runs].sort((a,b)=>b.builtAt.localeCompare(a.builtAt)).filter(r => {
      const key = `${r.source}/${r.from}/${r.to}/${r.profile}/${r.precision}`;
      if (keys.has(key)) return false; keys.add(key); return true;
    });
    const preferred = runs.find(r=>r.profile==="price-volume"&&r.precision==="quotes"&&r.source==="offline") ?? runs.find(r=>r.profile==="price-volume"&&r.source==="offline") ?? runs[0];
    const selected = id ?? preferred?.id;
    if (!selected || !index.runs.some(r=>r.id===selected)) return { ...empty, runs, error: "未找到该研究版本。" };
    const report = await readResearchReport(selected, true);
    // Full immutable evidence remains available via JSON download. Avoid huge RSC payloads.
    return { report: report ? { ...report, events: report.events.slice(0, 500) } : null, runs, error: report ? null : "目录已更新，但报告文件尚未就绪。" };
  } catch (e) { return { ...empty, error: e instanceof Error ? e.message : "研究数据读取失败" }; }
}
