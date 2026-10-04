import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { writeJsonAtomic } from "@/lib/files/atomicJson";
import { snapshotDir } from "@/lib/vps/snapshot";
import { marketBaseUrl } from "@/lib/backtest/marketStore";
import { fetchMarketText } from "@/lib/backtest/marketRemote";
import { fingerprint, parseValuation } from "./engine";
import { verifyFundamentalAnalysis } from "./analyst";
import { stateSchema, symbolSchema, type FundamentalState, type FundamentalValuation, type FundamentalPageData } from "./types";

export const fundamentalDirectory = () => path.join(snapshotDir(), "fundamental-target");
const file = (directory: string, symbol: string) => path.join(directory, symbolSchema.parse(symbol), "latest.json");
const readJson = (name: string): unknown => JSON.parse(readFileSync(name, "utf8"));

export function parseState(raw: unknown, symbol: string): FundamentalState {
  const state = stateSchema.parse(raw);
  if (state.symbol !== symbol || state.current && state.current.symbol !== symbol || state.status === "ready" && !state.current)
    throw new Error("估值状态标的或状态不一致");
  if (state.current) {
    parseValuation(state.current);
    verifyFundamentalAnalysis(state.current);
    if (Date.parse(state.current.publishedAt) > Date.parse(state.checkedAt)) throw new Error("估值状态时间不一致");
  }
  return state;
}

export function readFundamentalState(symbol: string, directory = fundamentalDirectory()): FundamentalState | null {
  const name = file(directory, symbol);
  return existsSync(name) ? parseState(readJson(name), symbol) : null;
}

/** Version first, then index, then current pointer. A failed write never destroys the previous target. */
export function saveFundamentalState(state: FundamentalState, directory = fundamentalDirectory()): void {
  const checked = parseState(state, state.symbol), folder = path.dirname(file(directory, state.symbol));
  const history = path.join(folder, "history");
  mkdirSync(history, { recursive: true });
  if (checked.current) {
    const name = path.join(history, `${checked.current.id}.json`), serialized = JSON.stringify(checked.current);
    try { writeFileSync(name, serialized + "\n", { flag: "wx" }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (JSON.stringify(readJson(name)) !== serialized) throw new Error("不能覆盖已有估值版本");
    }
  }
  const check = { checkedAt: checked.checkedAt, status: checked.status, currentId: checked.current?.id ?? null };
  const checksFolder = path.join(folder, "checks");
  mkdirSync(checksFolder, { recursive: true });
  const checkFile = path.join(checksFolder, `${fingerprint(check)}.json`);
  try { writeFileSync(checkFile, JSON.stringify(check) + "\n", { flag: "wx" }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const versions = readdirSync(history).filter(name => /^[a-f0-9]{64}\.json$/.test(name)).map(name => {
    const value = parseValuation(readJson(path.join(history, name)));
    return { id: value.id, publishedAt: value.publishedAt };
  }).sort((a, b) => b.publishedAt.localeCompare(a.publishedAt) || a.id.localeCompare(b.id));
  const checks = readdirSync(checksFolder).filter(name => /^[a-f0-9]{64}\.json$/.test(name))
    .map(name => checkSchema.parse(readJson(path.join(checksFolder, name))))
    .sort((a, b) => b.checkedAt.localeCompare(a.checkedAt));
  writeJsonAtomic(path.join(folder, "index.json"), { version: 1, symbol: state.symbol, versions, checks });
  writeJsonAtomic(path.join(folder, "latest.json"), checked);
}

const checkSchema = z.object({ checkedAt: z.iso.datetime(), status: stateSchema.shape.status,
  currentId: z.string().regex(/^[a-f0-9]{64}$/).nullable() });
const indexSchema = z.object({ version: z.literal(1), symbol: symbolSchema,
  checks: z.array(checkSchema).max(20000),
  versions: z.array(z.object({ id: z.string().regex(/^[a-f0-9]{64}$/), publishedAt: z.iso.datetime() })).max(10000) });

/** No vendor/LLM calls. Explicit remote reads never fall back to a build-time local snapshot. */
export async function getFundamentalPage(symbol: string, options: { entryAt?: string; now?: Date; directory?: string; includeHistory?: boolean } = {}): Promise<FundamentalPageData> {
  const now = options.now ?? new Date();
  const demo = (process.env.FUNDAMENTAL_DEMO_SYMBOLS ?? "").split(",").some(value => {
    const parsed = symbolSchema.safeParse(value.trim().toUpperCase());
    return parsed.success && parsed.data === symbol;
  });
  const data: FundamentalPageData = { symbol, state: null, history: [], atEntry: null, entryAt: null, error: null,
    ...(demo ? { demo: true } : {}) };
  try {
    symbolSchema.parse(symbol);
    if (options.entryAt) {
      const timestamp = z.iso.datetime({ offset: true }).parse(options.entryAt);
      if (Date.parse(timestamp) > now.getTime()) throw new Error("future entry");
      data.entryAt = new Date(timestamp).toISOString();
    }
    const directory = options.directory ?? fundamentalDirectory();
    const remote = !options.directory && Boolean(marketBaseUrl());
    const read = async (name: string): Promise<unknown> => {
      if (remote) {
        const text = await fetchMarketText(`snapshots/fundamental-target/${symbol}/${name}`, AbortSignal.timeout(6000));
        if (Buffer.byteLength(text) > 2_000_000) throw new Error("oversized snapshot");
        return text.trim() ? JSON.parse(text) : null;
      }
      const full = path.join(directory, symbol, name);
      return existsSync(full) ? readJson(full) : null;
    };
    const raw = await read("latest.json");
    if (!raw) return data;
    let state = parseState(raw, symbol);
    if (Date.parse(state.checkedAt) > now.getTime()) throw new Error("future snapshot");
    if (state.status === "ready" && state.current &&
      (Date.parse(state.current.validUntil) <= now.getTime() || now.getTime() - Date.parse(state.checkedAt) > 48 * 3600000))
      state = { ...state, status: "stale", reasons: [...state.reasons, "后台复核已超时，展示上一有效版本"] };
    data.state = state;
    if (options.includeHistory === false) return data;
    const rawIndex = await read("index.json");
    if (!rawIndex) return data;
    const index = indexSchema.parse(rawIndex);
    if (index.symbol !== symbol) throw new Error("wrong index");
    const versions = index.versions.filter(row => Date.parse(row.publishedAt) <= now.getTime())
      .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
    const entryCheck = data.entryAt ? index.checks.filter(check => check.checkedAt <= data.entryAt!)
      .sort((a, b) => b.checkedAt.localeCompare(a.checkedAt))[0] : null;
    const entryVersion = entryCheck?.status === "ready" &&
      Date.parse(data.entryAt!) - Date.parse(entryCheck.checkedAt) <= 48 * 3600000
      ? versions.find(row => row.id === entryCheck.currentId && row.publishedAt <= data.entryAt!) : null;
    const ids = [...new Set([...versions.slice(0, 12).map(row => row.id), ...(entryVersion ? [entryVersion.id] : [])])];
    const loaded = await Promise.all(ids.map(async id => {
      const value = parseValuation(await read(`history/${id}.json`));
      verifyFundamentalAnalysis(value);
      if (value.symbol !== symbol || value.id !== id || value.publishedAt !== versions.find(row => row.id === id)?.publishedAt)
        throw new Error("history mismatch");
      return value;
    }));
    data.history = loaded.slice(0, 12);
    const atEntry = entryVersion ? loaded.find(value => value.id === entryVersion.id) ?? null : null;
    // A later check/analysis is never treated as knowledge available at a historical buy point.
    data.atEntry = atEntry && Date.parse(atEntry.validUntil) > Date.parse(data.entryAt!) ? atEntry : null;
    return data;
  } catch {
    return { ...data, history: [], atEntry: null, error: "暂时无法读取有效基本面估值快照，请稍后重试。" };
  }
}
