import { describe, expect, it } from "vitest";
import { runRotate, type RotateCheckpoint } from "@/lib/fund/rotate";
import { rotateCheckpointOf } from "@/lib/fund/rotateCheckpoint";
import { type PreparedSymbol, type PreparedUniverse } from "@/lib/backtest/engine";
import { config, options } from "./continuousBookFixtures";

function scenario(seed: number): PreparedUniverse {
  let state = seed;
  const random = () => ((state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  const axis = Array.from({ length: 160 }, (_, i) => new Date(Date.UTC(2026, 0, 1 + i, 14, 30)).toISOString().slice(0, 16));
  const symbols = Array.from({ length: 6 }, (_, n): PreparedSymbol => {
    const indices = Array.from({ length: axis.length }, (_, i) => i).filter(i => i < 32 || random() > 0.15);
    let price = 100;
    const closes = indices.map(() => (price = Math.max(20, price * (0.94 + random() * 0.12))));
    return {
      ticker: `TEST${n}`, axisIndex: Int32Array.from(indices),
      high: Float32Array.from(closes.map(p => p * 1.015)), low: Float32Array.from(closes.map(p => p * 0.985)),
      close: Float32Array.from(closes), open: Float32Array.from(closes.map(p => p * (0.99 + random() * 0.02))),
      buy1: Uint8Array.from(closes.map(() => Number(random() < 0.16))),
      buy2: Uint8Array.from(closes.map(() => Number(random() < 0.12))),
      rps: Float32Array.from(closes.map(() => Math.floor(random() * 100))),
      isMember: new Uint8Array(closes.length).fill(1),
      adtv50: new Float32Array(closes.length).fill(1e9), aboveTrend: new Uint8Array(closes.length).fill(1),
      rsi14: new Float32Array(closes.length).fill(60), vegasOk: new Uint8Array(closes.length).fill(1),
    };
  });
  return { axis, symbols };
}

describe("独立信号在不齐行情轴与多次重启下的守恒", () => {
  it.each([7, 42, 99, 2026, 65535])("seed %s：逐段 JSON 恢复与一次运行一致", seed => {
    const uni = scenario(seed);
    const cfg = { ...config, from: uni.axis[30], to: uni.axis.at(-1)!, rpsMin: 30, rpsExit: 10 };
    const opts = { ...options, separateSignalState: true, slotPct: 0.3,
      entryGate: (ticker: string, date: string) => ticker !== "TEST1" || date >= uni.axis[85],
      fillGate: (ticker: string, date: string) => ticker !== "TEST1" || date >= uni.axis[85] };
    const whole = runRotate(uni, cfg, opts);
    let checkpoint: RotateCheckpoint | undefined;
    const book = [];
    for (const end of [34, 35, 38, 45, 53, 76, 88, 111, 129, 159]) {
      const part = runRotate(uni, { ...cfg, to: uni.axis[end] }, { ...opts, continuation: { capture: true, checkpoint } });
      book.push(...part.book);
      checkpoint = rotateCheckpointOf(JSON.parse(JSON.stringify(part.checkpoint)));
      expect(checkpoint.cash).toBeGreaterThanOrEqual(-1e-8);
      expect(checkpoint.orders.reduce((sum, order) => sum + order.amount, 0)).toBeLessThanOrEqual(checkpoint.cash + 1e-8);
    }
    expect(book).toEqual(whole.book);
    expect(checkpoint).toEqual(whole.checkpoint);
    expect(runRotate(uni, cfg, { ...opts, continuation: { capture: true, checkpoint } }).checkpoint).toEqual(checkpoint);
  });
});
