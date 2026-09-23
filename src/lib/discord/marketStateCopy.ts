import {
  optionsStructure,
  structureSentence,
  FLIP_LABEL,
  GAMMA_LABEL,
} from "@/lib/options/structure";
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

export function pickPrimary(
  items: readonly GexSnapshotItem[],
): GexSnapshotItem | null {
  return items.find((row) => row.symbol === "SPX") ?? items[0] ?? null;
}

export function marketHeadline(row: GexSnapshotItem): string {
  return `${structureSentence(row)}。`;
}

function isNearFlip(row: GexSnapshotItem): boolean {
  return optionsStructure(row).flip === "near";
}

export function marketLevels(row: GexSnapshotItem): MarketLevelView[] {
  const s = optionsStructure(row),
    v = s.values;
  const rows = [
    {
      value: v.call_wall,
      level: fmtLevel(v.call_wall),
      role: "Call 墙",
      meaning: "现价上方优先选取的近端 Call GEX 主档",
    },
    {
      value: v.spot,
      level: fmtLevel(v.spot),
      role: "快照现价",
      meaning: `${FLIP_LABEL[s.flip]}；${GAMMA_LABEL[s.gamma]}`,
    },
    {
      value: v.gamma_flip,
      level: fmtLevel(v.gamma_flip),
      role: "Gamma Flip",
      meaning: "模型 GEX(S) 过零点，取距离现价最近的交点",
    },
    {
      value: v.put_wall,
      level: fmtLevel(v.put_wall),
      role: "Put 墙",
      meaning: "现价下方优先选取的近端 Put GEX 主档",
    },
  ];
  return rows
    .filter((item) => item.value != null && Number.isFinite(item.value))
    .sort((a, b) => (b.value as number) - (a.value as number))
    .map(({ level, role, meaning }) => ({ level, role, meaning }));
}

export function marketPeerLine(row: GexSnapshotItem): string {
  return `${fmtLevel(row.spot)} · ${structureSentence(row)}`;
}

export function marketClose(
  primary: GexSnapshotItem,
  peers: readonly GexSnapshotItem[],
): string {
  const parts = [primary, ...peers].map((row) => {
    const s = optionsStructure(row);
    return `${row.symbol} ${FLIP_LABEL[s.flip]}、${GAMMA_LABEL[s.gamma]}`;
  });
  return `${parts.join("。")}。截面描述，不是操作计划。`;
}

export function marketStateFromSnapshot(
  snapshot: GexSnapshot,
): MarketStateView | null {
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
    netGex: netGexLabel(optionsStructure(primary).values.net_gex),
    netGexTone: netGexTone(optionsStructure(primary).values.net_gex),
    flip: fmtLevel(primary.gamma_flip),
    status: GAMMA_LABEL[optionsStructure(primary).gamma],
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
  return netGexTone(optionsStructure(row).values.net_gex);
}
