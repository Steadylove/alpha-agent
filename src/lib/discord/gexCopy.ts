import { STRATEGY_TITLE } from "./brand";
import { formatEtStamp, formatEtFromUtc } from "./cardTime";

import {
  optionsStructure,
  structureSentence,
  GAMMA_LABEL,
  type GexSnapshot,
  type GexSnapshotItem,
} from "@/lib/options/structure";
export type { GexSnapshot, GexSnapshotItem } from "@/lib/options/structure";

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
  headline?: string;
  note: string;
  rows: GexRowView[];
};

export function gexCaption(test: boolean): string {
  return test
    ? `📊 **${STRATEGY_TITLE} · GEX**（测试）`
    : `📊 **${STRATEGY_TITLE} · GEX**`;
}

export function fmtLevel(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  if (value >= 1000) return value.toFixed(0);
  if (value >= 100) return trimNum(value.toFixed(1));
  return trimNum(value.toFixed(2));
}

export function netGexLabel(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const sign = value >= 0 ? "+" : "-";
  const abs = Math.abs(value);
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(0)}K`;
  return `${sign}$${abs.toFixed(0)}`;
}

export function netGexTone(
  value: number | null | undefined,
): "pos" | "neg" | "flat" {
  if (value != null && value > 0) return "pos";
  if (value != null && value < 0) return "neg";
  return "flat";
}

export function fmtAsOf(value: string | undefined): string {
  if (!value) return "—";
  return /(Z|[+-]\d{2}:?\d{2})$/.test(value)
    ? formatEtFromUtc(value)
    : formatEtStamp(value);
}

export function gexImpact(row: GexSnapshotItem): string {
  return structureSentence(row);
}

export function gexClosingNote(
  items: readonly GexSnapshotItem[],
  tnxLast: number | null | undefined,
): string {
  const groups = ["positive", "negative", "zero", "unknown"] as const;
  const parts = groups.flatMap((gamma) => {
    const symbols = items
      .filter((row) => optionsStructure(row).gamma === gamma)
      .map((row) => row.symbol);
    return symbols.length
      ? [`${symbols.join("、")} ${GAMMA_LABEL[gamma]}`]
      : [];
  });
  const note = parts.length
    ? `${parts.join("；")}。符号与 Flip 位置分别判断。`
    : "缺少可描述的 GEX 截面。";
  return tnxLast != null && Number.isFinite(tnxLast)
    ? `10Y ${tnxLast.toFixed(2)}%。${note}`
    : note;
}

export function gexCardFromSnapshot(snapshot: GexSnapshot): GexCardView {
  const items = snapshot.items ?? [];
  const asOf =
    items.find((row) => row.symbol === "SPX")?.as_of ??
    items.find((row) => row.as_of)?.as_of;
  return {
    asOf: fmtAsOf(asOf),
    dte: snapshot.dte ?? "0-45d",
    tnx:
      snapshot.tnx?.last != null && Number.isFinite(snapshot.tnx.last)
        ? snapshot.tnx.last.toFixed(2)
        : null,
    note: gexClosingNote(items, snapshot.tnx?.last),
    rows: items.map((row) => ({
      symbol: row.symbol,
      spot: fmtLevel(optionsStructure(row).values.spot),
      status: GAMMA_LABEL[optionsStructure(row).gamma],
      netGex: netGexLabel(optionsStructure(row).values.net_gex),
      netGexTone: netGexTone(optionsStructure(row).values.net_gex),
      flip: fmtLevel(optionsStructure(row).values.gamma_flip),
      callWall: fmtLevel(optionsStructure(row).values.call_wall),
      putWall: fmtLevel(optionsStructure(row).values.put_wall),
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
