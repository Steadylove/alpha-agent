import type { FundamentalValuation } from "./types";

export type PeerSensitivity = {
  status: "ready" | "insufficient";
  sampleCount: number;
  low: number | null;
  high: number | null;
  maxChangePct: number | null;
};

/** Leave out each saved peer once; same EPS, scenario weights and P/E quartile convention.
 * This diagnoses sample dependence, not a new target or statistically calibrated confidence. */
export function peerSensitivity(value: FundamentalValuation): PeerSensitivity {
  const sampleCount = value.peers.length;
  if (sampleCount < 4) return { status: "insufficient", sampleCount, low: null, high: null, maxChangePct: null };
  const targets = value.peers.map((_, excluded) => {
    const multiples = value.peers.filter((_, index) => index !== excluded).map(peer => peer.pe).sort((a, b) => a - b);
    return (["bear", "base", "bull"] as const).reduce((sum, key, index) => {
      const position = (multiples.length - 1) * [0.25, 0.5, 0.75][index];
      const lower = Math.floor(position), upper = Math.ceil(position);
      const multiple = multiples[lower] + (multiples[upper] - multiples[lower]) * (position - lower);
      const scenario = value.twelveMonth[key];
      return sum + scenario.eps * multiple * scenario.weight;
    }, 0);
  });
  return {
    status: "ready", sampleCount, low: Math.min(...targets), high: Math.max(...targets),
    maxChangePct: Math.max(...targets.map(target => Math.abs(target / value.twelveMonth.weightedTarget - 1) * 100)),
  };
}
