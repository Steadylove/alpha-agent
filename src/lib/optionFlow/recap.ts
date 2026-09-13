import { fmtLevel, netGexLabel, type GexSnapshot, type GexSnapshotItem } from "@/lib/discord/gexCopy";
import { formatPremium } from "./cardImage";
import {
  biasLabel,
  flowLean,
  flowSide,
  sideLabel,
  type FlowDigestView,
  type FlowLean,
} from "./digest";
import type { OptionFlowLeg } from "./types";

const TOP_N = 8;
const DISCORD_SAFE = 1800;

export type RecapTopLeg = {
  ticker: string;
  side: string;
  strike: string;
  expiry: string;
  premium: string;
  lean: FlowLean;
};

export type RecapGexRow = {
  symbol: string;
  line: string;
};

export type FlowRecapView = {
  day: string;
  title: string;
  biasLine: string;
  bullUsd: number;
  bearUsd: number;
  buyCallUsd: number;
  sellPutUsd: number;
  buyPutUsd: number;
  sellCallUsd: number;
  top: RecapTopLeg[];
  more: number;
  notes: { ticker: string; text: string }[];
  gex: RecapGexRow[];
};

function premiumOf(leg: OptionFlowLeg): number {
  return leg.premiumUsd ?? 0;
}

function bucketUsd(legs: readonly OptionFlowLeg[], right: "call" | "put", side: "buyer" | "seller"): number {
  return legs
    .filter((leg) => leg.right === right && flowSide("", leg.note) === side)
    .reduce((sum, leg) => sum + premiumOf(leg), 0);
}

function gexLine(row: GexSnapshotItem): string {
  const tone = row.net_gex > 0 ? "净 GEX 偏正" : row.net_gex < 0 ? "净 GEX 偏负" : "净 GEX 近零";
  return `${row.symbol} 现价 ${fmtLevel(row.spot)} · Flip ${fmtLevel(row.gamma_flip)} · Put 墙 ${fmtLevel(row.put_wall)} · Call 墙 ${fmtLevel(row.call_wall)} · ${tone} ${netGexLabel(row.net_gex)}`;
}

export function buildDailyRecap(digest: FlowDigestView, snapshot?: GexSnapshot): FlowRecapView {
  const legs = digest.legs;
  return {
    day: digest.day,
    title: `${digest.title.replace("期权流 · ", "期权流与结构 · ")}`,
    biasLine: biasLabel(digest),
    bullUsd: digest.bullUsd,
    bearUsd: digest.bearUsd,
    buyCallUsd: bucketUsd(legs, "call", "buyer"),
    sellPutUsd: bucketUsd(legs, "put", "seller"),
    buyPutUsd: bucketUsd(legs, "put", "buyer"),
    sellCallUsd: bucketUsd(legs, "call", "seller"),
    top: legs.slice(0, TOP_N).map((leg) => ({
      ticker: leg.ticker,
      side: sideLabel(leg),
      strike: leg.strike != null ? `$${leg.strike}` : "—",
      expiry: leg.expiry ?? "—",
      premium: formatPremium(leg.premiumUsd),
      lean: flowLean(leg.right, flowSide("", leg.note)) ?? "bull",
    })),
    more: Math.max(0, legs.length - TOP_N),
    notes: digest.notes,
    gex: (snapshot?.items ?? []).map(gexLine).map((line, i) => ({
      symbol: snapshot!.items[i]!.symbol,
      line,
    })),
  };
}

export function formatDailyRecap(view: FlowRecapView): string {
  const lines = [
    `**${view.title}**`,
    "仅 FL0WG0D 完整单与当日 GEX。未写入暗池、新闻、经济日历、Sweep 分类。",
    "",
    `**方向** ${view.biasLine}`,
    `看涨 ${formatPremium(view.bullUsd)}（买 Call ${formatPremium(view.buyCallUsd)} + 卖 Put ${formatPremium(view.sellPutUsd)}）`,
    `看跌 ${formatPremium(view.bearUsd)}（买 Put ${formatPremium(view.buyPutUsd)} + 卖 Call ${formatPremium(view.sellCallUsd)}）`,
  ];
  if (view.top.length) {
    lines.push("", "**金额最大**");
    view.top.forEach((leg, i) => {
      lines.push(`${i + 1}. ${leg.ticker} ${leg.side} ${leg.strike} ${leg.expiry} ${leg.premium} · ${leg.lean === "bear" ? "看跌" : "看涨"}`);
    });
    if (view.more > 0) lines.push(`其余 ${view.more} 笔见上图，不另编。`);
  }
  if (view.gex.length) {
    lines.push("", "**GEX**");
    for (const row of view.gex) lines.push(row.line);
  }
  if (view.notes.length) {
    lines.push("", "**备注（原文）**");
    for (const note of view.notes) lines.push(note.ticker ? `${note.ticker} · ${note.text}` : note.text);
  }
  const text = lines.join("\n");
  return text.length <= DISCORD_SAFE ? text : `${text.slice(0, DISCORD_SAFE - 1)}…`;
}
