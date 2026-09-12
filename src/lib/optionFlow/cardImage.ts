import { CARD_INK as T } from "@/lib/discord/cardTheme";
import { reportCard } from "@/lib/discord/reportCardLayout";
import { renderReportCardPng, reportCardSvg } from "@/lib/discord/reportCardImage";
import type { OptionFlowLeg, OptionFlowPost } from "./types";

export function formatPremium(n?: number): string {
  if (n == null || !Number.isFinite(n)) return "—";
  if (n >= 1e9) return `$${trimNum(n / 1e9)}B`;
  if (n >= 1e6) return `$${trimNum(n / 1e6)}M`;
  if (n >= 1e3) return `$${trimNum(n / 1e3)}K`;
  return `$${Math.round(n)}`;
}

function trimNum(n: number): string {
  const digits = n >= 100 ? 0 : 1;
  return n.toFixed(digits).replace(/\.0$/, "");
}

export function formatExpiry(raw?: string): string {
  if (!raw) return "—";
  if (raw === "next-year") return "次年";
  if (raw === "0DTE") return "0DTE";
  if (raw === "LEAPS") return "LEAPS";
  if (raw === "two weeks") return "两周内";
  if (raw === "next week") return "一周内";
  const weeks = raw.match(/^(\d+) weeks$/);
  if (weeks) return `${weeks[1]}周内`;
  if (/^\d{2}$/.test(raw)) return `${Number(raw)}月`;
  return raw;
}

function formatTime(iso: string): string {
  const offset = iso.match(/(Z|[+-]\d{2}:\d{2})$/)?.[1];
  const zone = offset === "Z" || offset === "+00:00" ? " UTC" : offset ? ` ${offset}` : "";
  return iso.replace("T", " ").slice(0, 16) + zone;
}

function rightLabel(right?: string): string {
  return right === "put" ? "PUT" : right === "call" ? "CALL" : "FLOW";
}

function rightColor(right?: string): string {
  return right === "put" ? T.stop : right === "call" ? T.buy : T.take;
}

export function singleFlowLayout(post: OptionFlowPost) {
  const card = reportCard(), { text, rect, line } = card;
  const leg = post.legs[0], accent = rightColor(leg?.right);
  const activity = leg?.note === "seller" ? "大额卖出" : leg?.note === "buyer" ? "大额买入" : "大额成交";
  card.header(leg?.ticker ?? "期权流", rightLabel(leg?.right), `期权流 · ${activity}`, formatTime(post.postedAt), accent, 54);

  text("成交金额", 40, 152, 360, 16, T.secondary);
  text(formatPremium(leg?.premiumUsd), 40, 178, 366, 54, accent, 700, "left", true);
  text(leg?.right === "call" ? "CALL · 看涨期权" : leg?.right === "put" ? "PUT · 看跌期权" : "合约类型待确认", 42, 259, 360, 16, T.muted);
  rect(428, 158, 1, 134, T.line);
  text("行权价格", 460, 163, 182, 15, T.muted);
  text(leg?.strike != null ? `$${leg.strike}` : "—", 460, 194, 182, 32, T.text, 700, "left", true);
  text("到期日", 680, 163, 240, 15, T.muted);
  text(formatExpiry(leg?.expiry), 680, 194, 240, 28, T.text, 700, "left", true);

  const details = [
    ...(leg?.otmPct != null ? [{ label: "价外幅度", value: `${leg.otmPct}%`, sub: "OTM" }] : []),
    ...(leg?.optionPrice != null ? [{ label: "期权成交价", value: `$${leg.optionPrice}`, sub: "每股权利金" }] : []),
  ];
  let y = 320;
  if (details.length) {
    line(y);
    details.forEach((detail, i) => {
      const x = 40 + 440 * i;
      text(`${detail.label} · ${detail.sub}`, x, y + 16, 416, 14, T.muted);
      text(detail.value, x, y + 43, 416, 27, T.secondary, 700, "left", true);
    });
    y += 100;
  }
  line(y);
  text("期权资金观察 · 非策略买点", 40, y + 16, 880, 13, T.muted);
  return card.finish(y + 57);
}

function flowListLayout(title: string, meta: string, legs: readonly OptionFlowLeg[], confirmed: boolean) {
  const card = reportCard(), { text, rect, line } = card;
  card.header(title, confirmed ? "OI" : "FLOW", confirmed ? "持仓量确认" : "当日汇总", meta, T.take);
  const premiumLegs = legs.filter((leg) => leg.premiumUsd != null && Number.isFinite(leg.premiumUsd));
  const total = premiumLegs.reduce((sum, leg) => sum + leg.premiumUsd!, 0);
  text(premiumLegs.length === legs.length ? "合计成交金额" : "已知成交金额", 40, 151, 410, 15, T.secondary);
  text(premiumLegs.length ? formatPremium(total) : "—", 40, 177, 410, 40, T.text, 700, "left", true);
  text("合约记录", 556, 154, 364, 14, T.muted, 400, "right");
  text(`${legs.length} 笔`, 556, 183, 364, 27, T.secondary, 700, "right");
  line(254);
  const cols = [
    { title: "标的", x: 52, width: 154 }, { title: "类型", x: 226, width: 100 },
    { title: "行权价格", x: 340, width: 152, end: true },
    { title: "到期日", x: 520, width: 182, end: true }, { title: "成交金额", x: 722, width: 186, end: true },
  ];
  cols.forEach((c) => text(c.title, c.x, 268, c.width, 13, T.muted, 400, c.end ? "right" : "left"));
  const startY = 303, rowH = 56;
  line(startY - 1);
  if (!legs.length) text("暂无合约记录", 40, startY + 16, 880, 18, T.secondary, 400, "center");
  legs.forEach((leg, i) => {
    const y = startY + rowH * i;
    if (i % 2 === 1) rect(40, y, 880, rowH, T.panel, 6);
    const values = [leg.ticker, leg.right ? rightLabel(leg.right) : "—", leg.strike != null ? `$${leg.strike}` : "—", formatExpiry(leg.expiry), formatPremium(leg.premiumUsd)];
    cols.forEach((col, j) => text(values[j], col.x, y + 15, col.width, 18,
      [1, 4].includes(j) ? rightColor(leg.right) : j === 0 ? T.text : T.secondary,
      [0, 4].includes(j) ? 700 : 400, col.end ? "right" : "left", true));
  });
  const endY = startY + Math.max(legs.length, 1) * rowH + 16;
  line(endY);
  text(confirmed ? "OI Confirmed · 期权资金观察 · 非策略买点" : "当日汇总 · 已去重 · 期权资金观察 · 非策略买点", 40, endY + 16, 880, 13, T.muted);
  return card.finish(endY + 57);
}

export function noteworthyLayout(post: OptionFlowPost) {
  return flowListLayout("期权流 · 确认名单", formatTime(post.postedAt), post.legs, true);
}

export function sessionDigestLayout(title: string, asOf: string, legs: OptionFlowLeg[]) {
  return flowListLayout(title, asOf, legs, false);
}

export function singleFlowSvg(post: OptionFlowPost): string {
  return reportCardSvg(singleFlowLayout(post));
}
export function noteworthySvg(post: OptionFlowPost): string {
  return reportCardSvg(noteworthyLayout(post));
}
export function sessionDigestSvg(title: string, asOf: string, legs: OptionFlowLeg[]): string {
  return reportCardSvg(sessionDigestLayout(title, asOf, legs));
}
export function renderSingleFlowPng(post: OptionFlowPost): Promise<Buffer> {
  return renderReportCardPng(singleFlowLayout(post));
}
export function renderNoteworthyPng(post: OptionFlowPost): Promise<Buffer> {
  return renderReportCardPng(noteworthyLayout(post));
}
export function renderSessionDigestPng(title: string, asOf: string, legs: OptionFlowLeg[]): Promise<Buffer> {
  return renderReportCardPng(sessionDigestLayout(title, asOf, legs));
}
