import {
  optionsStructure,
  type OptionsMeta,
  type OptionsStructure,
  type OptionField,
} from "@/lib/options/structure";
import type { OptionsRow } from "./types";

export type StructureShift = {
  field: Exclude<OptionField, "spot">;
  from: number;
  to: number;
  delta: number;
  signChange?: boolean;
};
export type OptionsComparison = "verified" | "legacy" | "unavailable";

/** Missing legacy metadata is explicit; known source/method mismatches are never compared. */
export function comparisonMetadata(
  a?: OptionsMeta,
  b?: OptionsMeta,
): OptionsComparison {
  const keys = ["source", "method", "method_version"] as const;
  if (keys.some((key) => a?.[key] !== b?.[key])) return "unavailable";
  return keys.every((key) => !!a?.[key]) ? "verified" : "legacy";
}

export function enrichOptionsRow(
  row: OptionsRow,
  basis: OptionsStructure["basis"] = "snapshot",
): OptionsRow {
  const structure = optionsStructure(row.today, row.meta, basis);
  const prior = optionsStructure(row.previous, row.previousMeta, basis);
  const comparison =
    row.comparable &&
    row.today &&
    row.previous &&
    (["gamma_flip", "put_wall", "call_wall", "net_gex"] as const).some(
      (field) => structure.values[field] != null && prior.values[field] != null,
    )
      ? comparisonMetadata(row.meta, row.previousMeta)
      : "unavailable";
  const shifts: StructureShift[] = [];
  if (comparison !== "unavailable") {
    for (const field of [
      "gamma_flip",
      "put_wall",
      "call_wall",
      "net_gex",
    ] as const) {
      const from = prior.values[field],
        to = structure.values[field];
      if (from == null || to == null || from === to) continue;
      shifts.push({
        field,
        from,
        to,
        delta: to - from,
        ...(field === "net_gex"
          ? { signChange: Math.sign(from) !== Math.sign(to) }
          : {}),
      });
    }
  }
  const labels = {
    gamma_flip: "Flip",
    put_wall: "Put Wall",
    call_wall: "Call Wall",
    net_gex: "Net GEX",
  };
  const changes = shifts
    .filter((s) => s.field !== "net_gex" || s.signChange)
    .map((s) =>
      s.field === "net_gex" && s.from * s.to < 0
        ? `Net GEX ${s.from > 0 ? "由正转负" : "由负转正"}`
        : `${labels[s.field]} ${s.from.toFixed(2)} → ${s.to.toFixed(2)}`,
    );
  if (comparison !== "unavailable" && !changes.length)
    changes.push("可比字段未见价位或 GEX 符号变化");
  return {
    ...row,
    comparable: comparison !== "unavailable",
    structure,
    comparison,
    shifts,
    changes,
  };
}

export function optionsRowForDisplay(row: OptionsRow): OptionsRow {
  // Keep saved versioned observations; reconstruct old reviews from their own raw snapshot only.
  return row.structure?.version === "options-structure-v1"
    ? row
    : enrichOptionsRow(row, "reconstructed");
}
