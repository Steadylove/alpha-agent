/** Shared, deterministic interpretation of a frozen GEX snapshot. No price forecast. */
export const OPTIONS_STRUCTURE_VERSION = "options-structure-v1" as const;
export const DEFAULT_NEAR_PCT = 0.2;
export type GexSnapshotItem = {
  symbol: string;
  spot: number;
  as_of?: string;
  net_gex: number | null;
  status: string;
  gamma_flip: number | null;
  call_wall: number | null;
  put_wall: number | null;
  contracts_used?: number;
  contracts_skipped_far?: number;
  balance?: number;
  gross_gex?: number;
  gex_at_flip?: number | null;
  iv30?: number | null;
  flip_search?: { low: number; high: number; found: boolean };
  quality?: { invalid_fields: string[]; warnings: string[] };
};
export type GexSnapshot = {
  fetched_at?: string;
  source?: string;
  method?: string;
  method_version?: string;
  dte?: string;
  review?: string[];
  tnx?: { last?: number | null } | null;
  items: GexSnapshotItem[];
};
export type OptionsMeta = Pick<
  GexSnapshot,
  "source" | "method" | "method_version" | "fetched_at"
>;
export type FlipPosition = "above" | "near" | "below" | "unknown";
export type WallPosition =
  | "near-put"
  | "near-call"
  | "near-both"
  | "inside"
  | "above-call"
  | "below-put"
  | "unknown";
export type GammaRegime = "positive" | "negative" | "zero" | "unknown";
export type OptionField =
  | "spot"
  | "gamma_flip"
  | "put_wall"
  | "call_wall"
  | "net_gex";
export type OptionsStructure = {
  version: typeof OPTIONS_STRUCTURE_VERSION;
  basis: "snapshot" | "reconstructed";
  asOf: string | null;
  nearPct: number;
  flip: FlipPosition;
  wall: WallPosition;
  gamma: GammaRegime;
  distances: { flip: number | null; put: number | null; call: number | null };
  wallPercentile: number | null;
  values: Record<OptionField, number | null>;
  issues: string[];
  provenance: OptionsMeta;
};
export const FLIP_LABEL: Record<FlipPosition, string> = {
  above: "Flip 上方",
  near: "贴近 Flip",
  below: "Flip 下方",
  unknown: "Flip 未知",
};
export const WALL_LABEL: Record<WallPosition, string> = {
  "near-put": "接近 Put Wall",
  "near-call": "接近 Call Wall",
  "near-both": "接近双墙",
  inside: "双墙之间",
  "above-call": "Call Wall 上方",
  "below-put": "Put Wall 下方",
  unknown: "墙位关系未知",
};
export const GAMMA_LABEL: Record<GammaRegime, string> = {
  positive: "GEX 为正",
  negative: "GEX 为负",
  zero: "GEX 为零",
  unknown: "GEX 未知",
};
export const finiteOption = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v);
export function optionSign(value: unknown): GammaRegime {
  return !finiteOption(value)
    ? "unknown"
    : value > 0
      ? "positive"
      : value < 0
        ? "negative"
        : "zero";
}

export function optionsStructure(
  row: GexSnapshotItem | null,
  provenance: OptionsMeta = {},
  basis: OptionsStructure["basis"] = "snapshot",
  nearPct = DEFAULT_NEAR_PCT,
): OptionsStructure {
  if (!finiteOption(nearPct) || nearPct < 0)
    throw new Error("Invalid options proximity threshold");
  const issues: string[] = [];
  const values = {} as OptionsStructure["values"];
  for (const field of [
    "spot",
    "gamma_flip",
    "put_wall",
    "call_wall",
    "net_gex",
  ] as const) {
    const v = row?.[field];
    const invalid =
      row?.quality?.invalid_fields.includes(field) ||
      (field !== "spot" && row?.contracts_used === 0);
    values[field] =
      !invalid && finiteOption(v) && (field === "net_gex" || v > 0) ? v : null;
  }
  const { spot, gamma_flip: flip, put_wall: put, call_wall: call } = values;
  if (!row) issues.push("缺少当日快照");
  else {
    if (spot == null) issues.push("现价缺失或无效");
    if (flip == null)
      issues.push(
        row.flip_search?.found === false
          ? "扫描范围内未找到 Flip"
          : "Flip 缺失或无效",
      );
    if (put == null) issues.push("Put Wall 缺失或无效");
    if (call == null) issues.push("Call Wall 缺失或无效");
    if (values.net_gex == null) issues.push("Net GEX 缺失或无效");
    if (row.contracts_used === 0) issues.push("无有效期权合约，停用结构判断");
    issues.push(...(row.quality?.warnings ?? []));
  }
  const distance = (level: number | null) =>
    spot != null && level != null ? ((spot - level) / level) * 100 : null;
  const distances = {
    flip: distance(flip),
    put: distance(put),
    call: distance(call),
  };
  // Tiny floating point tolerance at the inclusive threshold; percentage-point units.
  const near = (v: number | null) =>
    v != null && Math.abs(v) <= nearPct + 1e-10;
  const flipPosition =
    distances.flip == null
      ? "unknown"
      : near(distances.flip)
        ? "near"
        : distances.flip > 0
          ? "above"
          : "below";
  let wall: WallPosition = "unknown";
  const ordered = put != null && call != null && put < call;
  if (put != null && call != null && !ordered)
    issues.push("双墙重合或倒置，停用区间判断");
  if (spot != null && (ordered || put == null || call == null)) {
    if (near(distances.put) && near(distances.call)) wall = "near-both";
    else if (near(distances.put)) wall = "near-put";
    else if (near(distances.call)) wall = "near-call";
    else if (ordered)
      wall = spot < put! ? "below-put" : spot > call! ? "above-call" : "inside";
  }
  return {
    version: OPTIONS_STRUCTURE_VERSION,
    basis,
    asOf: row?.as_of ?? null,
    nearPct,
    flip: flipPosition,
    wall,
    gamma: optionSign(values.net_gex),
    distances,
    wallPercentile:
      spot != null && ordered ? ((spot - put!) / (call! - put!)) * 100 : null,
    values,
    issues: [...new Set(issues)],
    provenance,
  };
}

export function structureSentence(row: GexSnapshotItem): string {
  const s = optionsStructure(row);
  return `${FLIP_LABEL[s.flip]} · ${WALL_LABEL[s.wall]} · ${GAMMA_LABEL[s.gamma]}`;
}
