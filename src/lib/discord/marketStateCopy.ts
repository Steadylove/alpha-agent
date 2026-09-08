import { STRATEGY_TITLE } from "./brand";
import {
  fmtAsOf,
  fmtLevel,
  gexCaption,
  gexCardFromSnapshot,
  netGexLabel,
  netGexTone,
  type GexCardView,
  type GexSnapshot,
  type GexSnapshotItem,
} from "./gexCopy";

const FLIP_NEAR = 0.002;

export type MarketLevelView = {
  level: string;
  role: string;
  meaning: string;
};

export type MarketPeerView = {
  symbol: string;
  line: string;
  tone: "pos" | "neg" | "flat";
};

export type MarketStateView = {
  asOf: string;
  dte: string;
  symbol: string;
  title: string;
  headline: string;
  spot: string;
  netGex: string;
  netGexTone: "pos" | "neg" | "flat";
  flip: string;
  status: string;
  levels: MarketLevelView[];
  peers: MarketPeerView[];
  close: string;
};

export function marketStateCaption(test: boolean): string {
  return test
    ? `📋 **${STRATEGY_TITLE} · 结构**（测试）`
    : `📋 **${STRATEGY_TITLE} · 结构**`;
}

export function pickPrimary(items: readonly GexSnapshotItem[]): GexSnapshotItem | null {
  return items.find((row) => row.symbol === "SPX") ?? items[0] ?? null;
}

export function marketHeadline(row: GexSnapshotItem): string {
  const flip = fmtLevel(row.gamma_flip);
  const call = fmtLevel(row.call_wall);
  const put = fmtLevel(row.put_wall);
  if (isNearFlip(row)) {
    return `现价贴近 Flip ${flip}，正负结构变薄。`;
  }
  if (row.net_gex > 0 && (row.gamma_flip == null || row.spot > row.gamma_flip)) {
    return `近月正 Gamma 仍成立。${flip} 是多空分界，${call} 是最大磁铁档。`;
  }
  if (row.net_gex < 0) {
    return `近月净 GEX 为负。${put} 是近端 Put 墙，${flip} 为分界。`;
  }
  return `近月结构在 Flip ${flip} 附近切换。`;
}

function isNearFlip(row: GexSnapshotItem): boolean {
  return row.gamma_flip != null && Math.abs(row.spot - row.gamma_flip) / row.spot <= FLIP_NEAR;
}

export function marketLevels(row: GexSnapshotItem): MarketLevelView[] {
  const above = row.gamma_flip != null && row.spot > row.gamma_flip;
  const callMeaning =
    row.net_gex > 0 ? "近端 Call GEX 最大档，正结构里价格常被吸向此档" : "近端 Call GEX 最大档";
  const putBelow = row.put_wall == null || row.spot >= row.put_wall;
  const rows = [
    { value: row.call_wall, level: fmtLevel(row.call_wall), role: "Call 墙 / 磁铁", meaning: callMeaning },
    {
      value: row.spot,
      level: fmtLevel(row.spot),
      role: "收盘现价",
      meaning: above ? "位于 Flip 上方，仍在正 GEX 一侧" : "位于 Flip 一侧或下方",
    },
    {
      value: row.gamma_flip,
      level: fmtLevel(row.gamma_flip),
      role: "Gamma Flip",
      meaning: "GEX(S) 过零。上方偏回归，下方近月净 GEX 翻负",
    },
    {
      value: row.put_wall,
      level: fmtLevel(row.put_wall),
      role: "Put 墙",
      meaning: putBelow ? "现价下方近端 Put GEX 主档" : "现价上方近端 Put GEX 主档",
    },
  ];
  return rows
    .filter((item) => item.value != null && Number.isFinite(item.value))
    .sort((a, b) => (b.value as number) - (a.value as number))
    .map(({ level, role, meaning }) => ({ level, role, meaning }));
}

export function marketPeerLine(row: GexSnapshotItem): string {
  const nearFlip = isNearFlip(row);
  if (nearFlip) {
    return `${fmtLevel(row.spot)} · ${row.status} · 现价贴 Flip ${fmtLevel(row.gamma_flip)}`;
  }
  if (row.net_gex < 0) {
    return `${fmtLevel(row.spot)} · ${row.status} · Flip ${fmtLevel(row.gamma_flip)} · Put ${fmtLevel(row.put_wall)}`;
  }
  return `${fmtLevel(row.spot)} · ${row.status} · Flip ${fmtLevel(row.gamma_flip)} · Call ${fmtLevel(row.call_wall)}`;
}

function peerBucket(row: GexSnapshotItem): "near" | "neg" | "pos" | "flat" {
  if (isNearFlip(row)) return "near";
  if (row.net_gex < 0) return "neg";
  if (row.net_gex > 0) return "pos";
  return "flat";
}

function peerClose(peers: readonly GexSnapshotItem[]): string {
  const groups = { near: [] as string[], neg: [] as string[], pos: [] as string[], flat: [] as string[] };
  for (const row of peers) groups[peerBucket(row)].push(row.symbol);
  const parts: string[] = [];
  if (groups.pos.length > 0) parts.push(`${groups.pos.join("、")} 仍在正侧`);
  if (groups.near.length > 0) parts.push(`${groups.near.join("、")} 贴 Flip`);
  if (groups.neg.length > 0) parts.push(`${groups.neg.join("、")} 近月净 GEX 为负`);
  if (groups.flat.length > 0) parts.push(`${groups.flat.join("、")} 在 Flip 附近`);
  return parts.length > 0 ? `${parts.join("，")}。` : "";
}

export function marketClose(primary: GexSnapshotItem, peers: readonly GexSnapshotItem[]): string {
  const box = `盒子底沿 ${fmtLevel(primary.put_wall)}/${fmtLevel(primary.gamma_flip)}，顶 ${fmtLevel(primary.call_wall)}`;
  const side = isNearFlip(primary) ? "临界" : primary.net_gex > 0 ? "正" : primary.net_gex < 0 ? "负" : "临界";
  return `${primary.symbol} 停在正负结构的${side}侧（${box}）。${peerClose(peers)}截面描述，不是操作计划。`;
}

export function marketStateFromSnapshot(snapshot: GexSnapshot): MarketStateView | null {
  const items = snapshot.items ?? [];
  const primary = pickPrimary(items);
  if (!primary) return null;
  const peers = items.filter((row) => row.symbol !== primary.symbol);
  return {
    asOf: fmtAsOf(primary.as_of ?? items[0]?.as_of),
    dte: snapshot.dte ?? "0-45d",
    symbol: primary.symbol,
    title: `${primary.symbol} 关键位与资金结构`,
    headline: marketHeadline(primary),
    spot: fmtLevel(primary.spot),
    netGex: netGexLabel(primary.net_gex),
    netGexTone: netGexTone(primary.net_gex),
    flip: fmtLevel(primary.gamma_flip),
    status: primary.status,
    levels: marketLevels(primary),
    peers: peers.map((row) => ({
      symbol: row.symbol,
      line: marketPeerLine(row),
      tone: nearTone(row),
    })),
    close: marketClose(primary, peers),
  };
}

export type GexBriefView = {
  gex: GexCardView;
  state: MarketStateView;
};

export function gexCardWithSummary(snapshot: GexSnapshot): GexCardView {
  const view = gexCardFromSnapshot(snapshot);
  const state = marketStateFromSnapshot(snapshot);
  if (!state) return view;
  return { ...view, headline: state.headline, note: state.close };
}

export function gexBriefFromSnapshot(snapshot: GexSnapshot): GexBriefView {
  const state = marketStateFromSnapshot(snapshot);
  if (!state) throw new Error("没有可描述的 GEX 截面");
  return { gex: gexCardFromSnapshot(snapshot), state };
}

export function gexBriefPushBody(snapshot: GexSnapshot, test = false) {
  return {
    filename: "gex.png",
    content: gexCaption(test),
    input: gexBriefFromSnapshot(snapshot),
  };
}

export function gexPushBodyWithSummary(snapshot: GexSnapshot, test = false) {
  return {
    filename: "gex.png",
    content: gexCaption(test),
    input: gexCardWithSummary(snapshot),
  };
}

export function marketStatePushBody(snapshot: GexSnapshot, test = false) {
  const input = marketStateFromSnapshot(snapshot);
  if (!input) throw new Error("没有可描述的 GEX 截面");
  return {
    filename: "market-state.png",
    content: marketStateCaption(test),
    input,
  };
}

function nearTone(row: GexSnapshotItem): "pos" | "neg" | "flat" {
  if (isNearFlip(row)) return "flat";
  return netGexTone(row.net_gex);
}
