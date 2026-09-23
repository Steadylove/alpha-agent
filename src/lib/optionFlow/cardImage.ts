import { CARD_TZ_ET, formatEtFromUtc } from "@/lib/discord/cardTime";
import { CARD_INK as T } from "@/lib/discord/cardTheme";
import { reportCard } from "@/lib/discord/reportCardLayout";
import { renderReportCardPng, reportCardSvg } from "@/lib/discord/reportCardImage";
import { biasLabel, flowLean, flowSide, sideLabel, type FlowDigestView } from "./digest";
import { normalizeExpiry } from "./expiry";
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

export function formatExpiry(raw?: string, asOf = ""): string {
  if (!raw) return "—";
  return normalizeExpiry(raw, asOf) ?? "日期待核实";
}

function formatTime(iso: string): string {
  return formatEtFromUtc(iso);
}

function sessionDay(iso: string): string {
  return formatEtFromUtc(iso).slice(0, 10);
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
  text(formatExpiry(leg?.expiry, sessionDay(post.postedAt)), 680, 194, 240, 28, T.text, 700, "left", true);

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

function flowListLayout(title: string, meta: string, legs: readonly OptionFlowLeg[], confirmed: boolean, asOf: string) {
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
    const values = [leg.ticker, leg.right ? rightLabel(leg.right) : "—", leg.strike != null ? `$${leg.strike}` : "—", formatExpiry(leg.expiry, asOf), formatPremium(leg.premiumUsd)];
    cols.forEach((col, j) => text(values[j], col.x, y + 15, col.width, 18,
      [1, 4].includes(j) ? rightColor(leg.right) : j === 0 ? T.text : T.secondary,
      [0, 4].includes(j) ? 700 : 400, col.end ? "right" : "left", true));
  });
  const endY = startY + Math.max(legs.length, 1) * rowH + 16;
  line(endY);
  text(confirmed ? "OI Confirmed · 期权资金观察 · 非策略买点" : "当日汇总 · 已去重 · 期权资金观察 · 非策略买点", 40, endY + 16, 880, 13, T.muted);
  return card.finish(endY + 57);
}

export function gexFlowLayout(post: OptionFlowPost) {
  const card = reportCard(), { text, line } = card;
  const leg = post.legs[0];
  const note = leg?.note === "put wall" ? "Put Wall" : leg?.note === "call wall" ? "Call Wall" : leg?.note === "gamma flip" ? "Gamma Flip" : "最强节点";
  card.header(leg?.ticker || "热力图", "GEX", `期权流 · ${note}`, formatTime(post.postedAt), T.take, 54);
  text("关键价位", 40, 152, 360, 16, T.secondary);
  text(leg?.strike != null ? String(leg.strike) : "—", 40, 178, 366, 54, T.take, 700, "left", true);
  if (leg?.premiumUsd != null) {
    text("权利金", 460, 163, 400, 15, T.muted);
    text(formatPremium(leg.premiumUsd), 460, 194, 400, 32, T.text, 700, "left", true);
  }
  line(320);
  text(post.thesis || "热力图观察", 40, 336, 880, 18, T.secondary);
  line(380);
  text("热力图观察 · 非策略买点", 40, 396, 880, 13, T.muted);
  return card.finish(437);
}

export function noteworthyLayout(post: OptionFlowPost) {
  return flowListLayout("期权流 · 确认名单", formatTime(post.postedAt), post.legs, true, sessionDay(post.postedAt));
}

export function sessionDigestLayout(title: string, asOf: string, legs: OptionFlowLeg[]) {
  return flowListLayout(title, formatTime(asOf), legs, false, sessionDay(asOf));
}

export function dailyDigestLayout(view: FlowDigestView) {
  const card = reportCard(), { text, rect, line } = card;
  const accent = view.bias === "bear" ? T.stop : view.bias === "bull" ? T.buy : T.take;
  const badge = view.bias === "bear" ? "BEAR" : view.bias === "bull" ? "BULL" : "FLOW";
  card.header(view.title, badge, "期权流 · 日结", `${view.day} ${CARD_TZ_ET}`, accent);

  text("重点方向", 40, 151, 410, 15, T.secondary);
  text(biasLabel(view), 40, 177, 520, 32, accent, 700, "left", true);
  text(`看涨 ${formatPremium(view.bullUsd)}  ·  看跌 ${formatPremium(view.bearUsd)}`, 40, 218, 520, 16, T.muted);
  text("合约记录", 556, 154, 364, 14, T.muted, 400, "right");
  text(`${view.legs.length} 笔`, 556, 183, 364, 27, T.secondary, 700, "right");

  let y = 254;
  if (view.spy) {
    line(y);
    text(`${view.spy.symbol} 伽马点位`, 40, y + 16, 880, 14, T.secondary);
    const cells = [
      { label: "现价", value: view.spy.spot },
      { label: "Gamma Flip", value: view.spy.flip },
      { label: "Put 墙", value: view.spy.putWall },
      { label: "Call 墙", value: view.spy.callWall },
    ];
    cells.forEach((cell, i) => {
      const x = 40 + 220 * i;
      text(cell.label, x, y + 42, 200, 13, T.muted);
      text(cell.value, x, y + 64, 200, 26, T.text, 700, "left", true);
    });
    y += 110;
  }

  line(y);
  const cols = [
    { title: "标的", x: 52, width: 140 }, { title: "方向", x: 206, width: 130 },
    { title: "行权价格", x: 350, width: 142, end: true },
    { title: "到期日", x: 520, width: 182, end: true }, { title: "成交金额", x: 722, width: 186, end: true },
  ];
  cols.forEach((c) => text(c.title, c.x, y + 14, c.width, 13, T.muted, 400, c.end ? "right" : "left"));
  const startY = y + 49, rowH = 56;
  line(startY - 1);
  if (!view.legs.length) text("当日无完整大额单", 40, startY + 16, 880, 18, T.secondary, 400, "center");
  view.legs.forEach((leg, i) => {
    const rowY = startY + rowH * i;
    if (i % 2 === 1) rect(40, rowY, 880, rowH, T.panel, 6);
    const lean = flowLean(leg.right, flowSide("", leg.note));
    const leanColor = lean === "bear" ? T.stop : lean === "bull" ? T.buy : T.take;
    const values = [leg.ticker, sideLabel(leg), leg.strike != null ? `$${leg.strike}` : "—", formatExpiry(leg.expiry, view.day), formatPremium(leg.premiumUsd)];
    cols.forEach((col, j) => text(values[j], col.x, rowY + 15, col.width, 18,
      [1, 4].includes(j) ? leanColor : j === 0 ? T.text : T.secondary,
      [0, 4].includes(j) ? 700 : 400, col.end ? "right" : "left", true));
  });
  let endY = startY + Math.max(view.legs.length, 1) * rowH + 16;
  if (view.notes.length) {
    line(endY);
    text("备注", 40, endY + 16, 880, 13, T.muted);
    view.notes.forEach((note, i) => {
      const label = note.ticker ? `${note.ticker}  ${note.text}` : note.text;
      text(label, 40, endY + 40 + i * 28, 880, 16, T.secondary);
    });
    endY += 40 + view.notes.length * 28 + 8;
  }
  line(endY);
  text("日结 · 已去重 · 期权资金观察 · 非策略买点", 40, endY + 16, 880, 13, T.muted);
  return card.finish(endY + 57);
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
export function renderGexFlowPng(post: OptionFlowPost): Promise<Buffer> {
  return renderReportCardPng(gexFlowLayout(post));
}
export function renderSessionDigestPng(title: string, asOf: string, legs: OptionFlowLeg[]): Promise<Buffer> {
  return renderReportCardPng(sessionDigestLayout(title, asOf, legs));
}
export function renderDailyDigestPng(view: FlowDigestView): Promise<Buffer> {
  return renderReportCardPng(dailyDigestLayout(view));
}
