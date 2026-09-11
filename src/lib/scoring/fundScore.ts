/** CAN SLIM+ 六维基本面分。缺维不加分，也不当成 C 级垃圾。 */

export type FundScoreInputs = {
  epsYoy: number | null;
  revYoy: number | null;
  roe: number | null;
  dist52w: number | null;
  gmTtm: number | null;
  debtEquity: number | null;
};

export type FundDimId = keyof FundScoreInputs;

export type FundScoreTier = "S+" | "S" | "A+" | "A" | "B" | "C";

export type FundDimScore = {
  id: FundDimId;
  label: string;
  value: number | null;
  points: number;
  max: number;
};

export type FundScore = {
  total: number;
  max: number;
  filled: number;
  complete: boolean;
  usable: boolean;
  tier: FundScoreTier | null;
  dims: FundDimScore[];
};

const DIMS: { id: FundDimId; label: string; max: number; points: (v: number) => number }[] = [
  { id: "epsYoy", label: "盈利增速", max: 25, points: (v) => (v >= 0.4 ? 25 : v >= 0.2 ? 15 : 0) },
  { id: "revYoy", label: "营收增速", max: 20, points: (v) => (v >= 0.3 ? 20 : v >= 0.15 ? 12 : 0) },
  { id: "roe", label: "资本回报", max: 20, points: (v) => (v >= 0.2 ? 20 : v >= 0.15 ? 12 : 0) },
  { id: "dist52w", label: "接近新高", max: 15, points: (v) => (v >= -10 ? 15 : v >= -20 ? 8 : 0) },
  { id: "gmTtm", label: "盈利质量", max: 10, points: (v) => (v >= 0.45 ? 10 : v >= 0.3 ? 6 : 0) },
  { id: "debtEquity", label: "债务风险", max: 10, points: (v) => (v <= 1.2 ? 10 : v <= 2 ? 5 : 0) },
];

export function fundScoreOf(input: FundScoreInputs): FundScore {
  const dims = DIMS.map((dim) => {
    const value = input[dim.id];
    return {
      id: dim.id,
      label: dim.label,
      value,
      points: value == null || !Number.isFinite(value) ? 0 : dim.points(value),
      max: dim.max,
    };
  });
  const filled = dims.filter((d) => d.value != null && Number.isFinite(d.value)).length;
  const total = dims.reduce((sum, d) => sum + (d.value == null ? 0 : d.points), 0);
  const complete = filled === DIMS.length;
  const usable = filled >= 5;
  return {
    total,
    max: 100,
    filled,
    complete,
    usable,
    tier: usable ? tierOf(total) : null,
    dims,
  };
}

export function tierOf(total: number): FundScoreTier {
  if (total >= 85) return "S+";
  if (total >= 70) return "S";
  if (total >= 55) return "A+";
  if (total >= 40) return "A";
  if (total >= 20) return "B";
  return "C";
}

export function formatFundRatio(id: FundDimId, value: number): string {
  if (id === "debtEquity") return value.toFixed(2);
  if (id === "dist52w") return `${value >= 0 ? "+" : ""}${value.toFixed(1)}%`;
  return `${value >= 0 ? "+" : ""}${(value * 100).toFixed(1)}%`;
}
