import { STRATEGY_TITLE } from "./brand";

export type GexSnapshotItem = {
  symbol: string;
  spot: number;
  as_of?: string;
  net_gex: number;
  status: string;
  gamma_flip: number | null;
  call_wall: number | null;
  put_wall: number | null;
};

export type GexSnapshot = {
  fetched_at?: string;
  dte?: string;
  tnx?: { last?: number | null } | null;
  items: GexSnapshotItem[];
};

export type GexRowView = {
  symbol: string;
  spot: string;
  status: string;
  netGex: string;
  netGexTone: "pos" | "neg" | "flat";
  flip: string;
  callWall: string;
  putWall: string;
  impact: string;
};

export type GexCardView = {
  asOf: string;
  dte: string;
  tnx: string | null;
  note: string;
  rows: GexRowView[];
};

const FLIP_NEAR = 0.002;

export function gexCaption(test: boolean): string {
  return test ? `📊 **${STRATEGY_TITLE} · GEX**（测试）` : `📊 **${STRATEGY_TITLE} · GEX**`;
}

export function fmtLevel(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  if (value >= 1000) return value.toFixed(0);
  if (value >= 100) return trimNum(value.toFixed(1));
  return trimNum(value.toFixed(2));
}

export function netGexLabel(value: number): string {
  const sign = value >= 0 ? "+" : "-";
  const abs = Math.abs(value);
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(0)}K`;
  return `${sign}$${abs.toFixed(0)}`;
}

export function netGexTone(value: number): "pos" | "neg" | "flat" {
  if (value > 0) return "pos";
  if (value < 0) return "neg";
  return "flat";
}

export function fmtAsOf(value: string | undefined): string {
  if (!value) return "—";
  return value.replace("T", " ").slice(0, 16);
}

export function gexImpact(row: GexSnapshotItem): string {
  const flip = row.gamma_flip;
  const spot = row.spot;
  if (flip != null && Math.abs(spot - flip) / spot <= FLIP_NEAR) {
    return `现价贴近 Flip ${fmtLevel(flip)}，波动易放大`;
  }
  if (row.net_gex > 0 && (flip == null || spot > flip)) {
    return `现价在 Flip 上方；上行看 ${fmtLevel(row.call_wall)}，正 GEX 偏均值回归`;
  }
  if (row.net_gex < 0) {
    return `现价在负 GEX；${fmtLevel(row.put_wall)} 为关键节点，失守波动易放大`;
  }
  return `先看 ${fmtLevel(row.put_wall)} / ${fmtLevel(row.call_wall)}`;
}

export function gexClosingNote(items: readonly GexSnapshotItem[], tnxLast: number | null | undefined): string {
  const weak = items.filter((row) => row.net_gex < 0).map((row) => row.symbol);
  const strong = items.filter((row) => row.net_gex > 0).map((row) => row.symbol);
  let note: string;
  if (strong.length > 0 && weak.length > 0) {
    note = `${strong.join("、")} 在 Flip 上方偏稳；${weak.join("、")} 近月净 GEX 为负，波动更易放大。`;
  } else if (weak.length > 0) {
    note = `${weak.join("、")} 近月净 GEX 为负，短线波动放大风险偏高。`;
  } else {
    note = "近月净 GEX 偏正，短线更偏向均值回归。";
  }
  if (tnxLast != null && Number.isFinite(tnxLast)) {
    note = `10Y ${tnxLast.toFixed(2)}%。${note}`;
  }
  return note;
}

export function gexCardFromSnapshot(snapshot: GexSnapshot): GexCardView {
  const items = snapshot.items ?? [];
  const asOf = items[0]?.as_of;
  return {
    asOf: fmtAsOf(asOf),
    dte: snapshot.dte ?? "0-45d",
    tnx: snapshot.tnx?.last != null && Number.isFinite(snapshot.tnx.last) ? snapshot.tnx.last.toFixed(2) : null,
    note: gexClosingNote(items, snapshot.tnx?.last),
    rows: items.map((row) => ({
      symbol: row.symbol,
      spot: fmtLevel(row.spot),
      status: row.status,
      netGex: netGexLabel(row.net_gex),
      netGexTone: netGexTone(row.net_gex),
      flip: fmtLevel(row.gamma_flip),
      callWall: fmtLevel(row.call_wall),
      putWall: fmtLevel(row.put_wall),
      impact: gexImpact(row),
    })),
  };
}

export function gexPushBody(snapshot: GexSnapshot, test = false) {
  return {
    filename: "gex.png",
    content: gexCaption(test),
    input: gexCardFromSnapshot(snapshot),
  };
}

function trimNum(value: string): string {
  return value.replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1");
}
