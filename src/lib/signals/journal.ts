import { createHash, randomUUID } from "node:crypto";
import { existsSync, linkSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { deskRemoteUrl, readDeskJson, writeDeskJson } from "@/lib/fund/deskRemote";
import { buildAlertView, type AlertPayload, type AlertView } from "@/lib/discord/tvAlertCopy";
import type { FundScore } from "@/lib/scoring/fundScore";
import { qualityPanel, tradeReviewOf, type EntrySnapshot } from "./assessment";

/** 参数、交易周期和买点时间都是身份的一部分。旧告警不猜测关联。 */
export function tradeIdOf(p: AlertPayload): string | null {
  if (typeof p.strategyKey !== "string" || !p.strategyKey || p.strategyKey.length > 512 ||
      !Number.isSafeInteger(p.entrySignalTime) || p.entrySignalTime! <= 0 ||
      !Number.isSafeInteger(p.barTime) || p.barTime! < p.entrySignalTime! ||
      (p.event === "buy" && p.barTime !== p.entrySignalTime)) return null;
  return createHash("sha256").update(JSON.stringify([p.symbol.toUpperCase(), p.tf, p.strategyKey, p.entrySignalTime])).digest("hex");
}

function localFile(file: string): string {
  if (!process.env.SIGNAL_JOURNAL_DIR && process.env.VERCEL) throw new Error("缺少持久化信号存储");
  return path.join(process.env.SIGNAL_JOURNAL_DIR || path.join(process.cwd(), ".cache/signal-journal"), file);
}
function remote(file: string): boolean { return !process.env.SIGNAL_JOURNAL_DIR && Boolean(deskRemoteUrl(file)); }

async function readRecord<T>(file: string): Promise<T | null> {
  if (remote(file)) return await readDeskJson(file, AbortSignal.timeout(2500)) as T | null;
  const name = localFile(file);
  return existsSync(name) ? JSON.parse(readFileSync(name, "utf8")) as T : null;
}

/** 第一份快照不可覆盖；并发重复告警取回已保存版本。 */
async function saveFirst<T>(file: string, value: T): Promise<T> {
  if (remote(file)) {
    try { await writeDeskJson(file, value, undefined, AbortSignal.timeout(2500)); }
    catch (error) {
      const existing = await readRecord<T>(file);
      if (existing) return existing;
      throw error;
    }
    return value;
  }
  const name = localFile(file);
  mkdirSync(path.dirname(name), { recursive: true });
  const temp = `${name}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify(value), { flag: "wx" });
    try { linkSync(temp, name); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  } finally { rmSync(temp, { force: true }); }
  return JSON.parse(readFileSync(name, "utf8")) as T;
}

export async function assessedAlertView(p: AlertPayload, label: string, rps?: number, fund?: FundScore): Promise<AlertView> {
  const view = buildAlertView(p, label, rps, fund);
  const id = tradeIdOf(p);
  if (!id) {
    view.assessment = p.event === "buy" ? qualityPanel(view.quality!, "入场关联信息缺失；更新 Pine 告警后才能保存并关联复盘") :
      tradeReviewOf(p, undefined, "旧版告警缺少交易标识，未用当前评分代替入场评分");
    return view;
  }
  try {
    if (p.event === "buy") {
      const saved = await saveFirst<EntrySnapshot>(`signal-entries/${id}.json`, {
        version: 1, id, capturedAt: new Date().toISOString(), payload: p, quality: view.quality!, rps, fund,
      });
      return { ...buildAlertView(saved.payload, label, saved.rps, saved.fund), quality: saved.quality, assessment: qualityPanel(saved.quality) };
    } else {
      const saved = await readRecord<EntrySnapshot>(`signal-entries/${id}.json`);
      const entry = saved?.id === id && saved.version === 1 && tradeIdOf(saved.payload) === id ? saved : undefined;
      view.assessment = tradeReviewOf(p, entry);
      // 未读到入场快照时也保留当时的缺失说明，重放不会用事后分数补历史。
      const review = await saveFirst(`signal-reviews/${id}.json`, {
        version: 1, id, capturedAt: new Date().toISOString(), payload: p, rps, fund, entry: entry ?? null, assessment: view.assessment,
      });
      return { ...buildAlertView(review.payload, label, review.rps, review.fund), assessment: review.assessment };
    }
  } catch {
    view.assessment = p.event === "buy" ? qualityPanel(view.quality!, "入场快照保存失败，本次分数未固定；请检查持久化服务") :
      tradeReviewOf(p, undefined, "交易存储不可用，入场评分或本次复盘未能保存");
    console.error("[signal-journal] persistence unavailable", p.symbol, p.tf, id);
  }
  return view;
}
