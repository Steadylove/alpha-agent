import { readSnapshot } from "@/lib/vps/snapshot";
import { marketBaseUrl } from "@/lib/backtest/marketStore";
import { fetchMarketText } from "@/lib/backtest/marketRemote";
import { etDay, eventTier, fingerprint, parseCatalystReport } from "./normalize";
import { catalystEvidence } from "./summary";
import type { CatalystEvent, CatalystPageData, CatalystReport, Relation } from "./types";

export const CATALYST_PAGE_BYTES = 1_500_000;
const rank = (a: CatalystEvent, b: CatalystEvent) => eventTier(a) - eventTier(b) || b.eventDate.localeCompare(a.eventDate) || ["high", "medium", "low"].indexOf(a.importance) - ["high", "medium", "low"].indexOf(b.importance) || a.id.localeCompare(b.id);
const compactRelations = (rows: Relation[]) => {
  // Keep every filter category even when a stock has many individual signal captures.
  const kinds = [...new Map(rows.map(row => [row.kind, row])).values()];
  return [...kinds, ...rows.filter(row => !kinds.includes(row))].slice(0, 12);
};

/** Bound the client payload only. The immutable research archive keeps every original field. */
export function projectCatalystPage(report: CatalystReport): CatalystReport {
  const at = Date.parse(report.generatedAt), today = etDay(report.generatedAt), end = etDay(new Date(at + 72 * 3_600_000));
  const dates = [...new Set(report.sessions)].filter(day => day <= today).sort();
  const start = dates.at(-7) ?? dates[0] ?? today;
  const recent = report.events.filter(event => {
    if (event.status === "scheduled") return false;
    const stamp = event.publishedAt ?? (event.timePrecision === "minute" ? event.eventAt : null);
    const day = stamp ? etDay(stamp) : event.eventDate;
    return day >= start && day <= today && (!stamp || Date.parse(stamp) <= at);
  }).sort(rank).slice(0, 200);
  const future = report.events.filter(event => {
    if (event.status !== "scheduled") return false;
    if (event.timePrecision === "minute" && event.eventAt) return Date.parse(event.eventAt) >= at && Date.parse(event.eventAt) <= at + 72 * 3_600_000;
    return event.eventDate >= today && event.eventDate <= end;
  }).sort(rank).slice(0, 40);
  const required = new Set(report.summaryStatus === "ready" ? report.summary?.sentences.flatMap(sentence => sentence.eventIds) ?? [] : []);
  const selected = new Map([...recent, ...future, ...report.events.filter(event => required.has(event.id))].map(event => [event.id, event]));
  const compactEvent = (event: CatalystEvent): CatalystEvent => ({ ...event, excerpt: event.excerpt.slice(0, 700), firstRelations: compactRelations(event.firstRelations), currentRelations: compactRelations(event.currentRelations), relatedSourceUrls: event.relatedSourceUrls.slice(0, 3) });
  const events = [...selected.values()].sort(rank).map(compactEvent);
  const priorities = new Map(events.map((event, index) => [event.id, index]));
  const page: CatalystReport = { ...report, events,
    reactions: report.reactions.filter(reaction => selected.has(reaction.eventId)).sort((a, b) => priorities.get(a.eventId)! - priorities.get(b.eventId)!).slice(0, 400)
      .map(reaction => ({ ...reaction, signalsAfter: reaction.signalsAfter.slice(0, 12) })),
    universe: { ...report.universe, signals: [], sectors: report.universe.sectors.map(sector => ({ ...sector, name: sector.name.slice(0, 200) })), symbols: report.universe.symbols.map(stock => ({ ...stock, name: stock.name.slice(0, 200), industry: stock.industry?.slice(0, 200) ?? null, relations: compactRelations(stock.relations) })) },
    warnings: report.warnings.slice(0, 20).map(warning => warning.slice(0, 600)),
  };
  const note = "网页为限量阅读视图：最近 7 个交易日最多 200 条事件、未来 72 小时最多 40 条日程，保留当前摘要引用；反应及关联明细也可能限量。日期/时段未定日程按美东日期边界纳入。来源计数是实际采集数，不等于网页展示数；完整留档保留在后台。";
  page.warnings.push(note);
  const size = () => Buffer.byteLength(JSON.stringify(page), "utf8");
  while (size() > CATALYST_PAGE_BYTES) {
    let index = page.events.length - 1;
    while (index >= 0 && required.has(page.events[index].id)) index--;
    if (index >= 0) {
      const [removed] = page.events.splice(index, 1);
      page.reactions = page.reactions.filter(reaction => reaction.eventId !== removed.id);
    } else if (page.reactions.length) page.reactions.pop();
    else if (page.universe.symbols.length) page.universe.symbols.pop();
    else {
      page.events = page.events.map(event => ({ ...event, excerpt: "", firstRelations: event.firstRelations.slice(0, 2), currentRelations: event.currentRelations.slice(0, 2), relatedSourceUrls: [] }));
      if (size() > CATALYST_PAGE_BYTES) throw new Error("事件阅读快照超过大小限制");
      break;
    }
  }
  return page;
}

/** Page reads saved output only; a visit never collects news or spends model tokens. */
export async function getCatalystPage(now = new Date()): Promise<CatalystPageData> {
  try {
    const signal = AbortSignal.timeout(8000);
    // An empty remote response must not fall back to a build-time local archive.
    let raw: unknown;
    if (marketBaseUrl()) {
      const text = await fetchMarketText("snapshots/catalyst/latest.json", signal);
      raw = text.trim() ? JSON.parse(text) : null;
    } else raw = await readSnapshot<unknown>("catalyst/latest", signal);
    if (!raw) return { report: null, error: "事件快照尚未生成。后台采集完成后会在这里显示。", stale: false };
    const report = parseCatalystReport(raw);
    const age = now.getTime() - Date.parse(report.generatedAt);
    if (age < -60_000) throw new Error("future snapshot");
    if (report.summaryStatus === "ready") {
      if (!report.summary || Date.parse(report.summary.generatedAt) > Date.parse(report.generatedAt) + 60_000) report.summaryStatus = "unavailable";
      else if (report.summary.inputHash !== fingerprint(catalystEvidence(report, new Date(report.generatedAt)))) report.summaryStatus = "stale";
    }
    return { report: projectCatalystPage(report), error: null, stale: age > 2 * 60 * 60_000 };
  } catch {
    return { report: null, error: "暂时无法读取有效事件快照，请稍后刷新。", stale: false };
  }
}
