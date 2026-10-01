import { describe, expect, it } from "vitest";
import { runRotate } from "@/lib/fund/rotate";
import { rotateCheckpointOf } from "@/lib/fund/rotateCheckpoint";
import { axis, config, options, symbol, universe } from "./continuousBookFixtures";

const opts = { ...options, separateSignalState: true, slotPct: 1 };
const prices = (drop: number) => axis.map((_, i) => i < drop ? 100 : 50);

describe("independent signal per-symbol watermark", () => {
  it("catches up late tail bars in shadow only and does not turn a repeated condition into a fresh buy", () => {
    const holder = symbol("HOLD", [30], prices(51));
    const rtx = symbol("RTX", [35, 46, 53], prices(42));
    const first = runRotate(universe(holder, symbol("RTX", [35, 46, 53], prices(42), 40)),
      { ...config, to: axis[50] }, opts);
    const saved = JSON.parse(JSON.stringify(first.checkpoint));
    const next = runRotate(universe(holder, rtx), { ...config, to: axis[60] }, {
      ...opts, continuation: { capture: true, checkpoint: rotateCheckpointOf(saved) },
    });

    expect(next.book.some((row) => row.buys.includes("RTX"))).toBe(false);
    expect(next.checkpoint!.signalTracking!.states.RTX.signalDate).toBe(axis[46]);
    expect(next.checkpoint!.signalTracking!.events.filter((event) => event.symbol === "RTX"))
      .toEqual(saved.signalTracking.events.filter((event: { symbol: string }) => event.symbol === "RTX"));
    expect(first.checkpoint).toEqual(saved);
  });

  it.each([36, 40, 43])("warms a lagging symbol with %i bars at the unchanged portfolio cutoff without adding fills or past events", (count) => {
    const holder = symbol("HOLD", [30], prices(80));
    const first = runRotate(universe(holder, symbol("RTX", [35, 46, 53], prices(42), count)),
      { ...config, to: axis[50] }, opts);
    const old = structuredClone(first.checkpoint!);
    const tracking = old.signalTracking!;
    expect(tracking.states.RTX.lastProcessedDate).toBe(axis[count - 1]);
    const next = runRotate(universe(holder, symbol("RTX", [35, 46, 53], prices(42))),
      { ...config, to: axis[50] }, { ...opts, continuation: { capture: true, checkpoint: old } });

    expect(next.book).toEqual([]);
    expect(next.trades).toEqual([]);
    expect(next.checkpoint).toEqual({ ...old, signalTracking: {
      ...tracking, states: { ...tracking.states, RTX: next.checkpoint!.signalTracking!.states.RTX },
    } });
    expect(next.checkpoint!.signalTracking!.states.RTX).toMatchObject({ signalDate: axis[46], lastProcessedDate: axis[50] });
    expect(old).toEqual(first.checkpoint);
    const again = runRotate(universe(holder, symbol("RTX", [35, 46, 53], prices(42))),
      { ...config, to: axis[50] }, { ...opts, continuation: { capture: true, checkpoint: next.checkpoint } });
    expect(again.checkpoint).toEqual(next.checkpoint);
    expect(rotateCheckpointOf(next.checkpoint)).toBe(next.checkpoint);
  });

  it("preserves an existing account association when repaired shadow history is already in another cycle", () => {
    const clock = symbol("CLOCK", [], prices(80));
    const first = runRotate(universe(clock, symbol("RTX", [35, 46, 53], prices(42), 40)),
      { ...config, to: axis[50] }, opts);
    const old = structuredClone(first.checkpoint!);
    const oldId = old.signalTracking!.accounts.RTX.signalId;
    const uni = universe(clock, symbol("RTX", [35, 46, 53], prices(42)));
    const repaired = runRotate(uni, { ...config, to: axis[50] }, { ...opts, continuation: { capture: true, checkpoint: old } });
    expect(repaired.checkpoint!.signalTracking!.states.RTX.signalDate).toBe(axis[46]);
    expect(repaired.checkpoint!.signalTracking!.accounts).toEqual(old.signalTracking!.accounts);
    expect(repaired.checkpoint!.signalTracking!.events).toEqual(old.signalTracking!.events);
    expect(repaired.checkpoint!.cash).toBe(old.cash);
    expect(repaired.checkpoint!.legs).toEqual(old.legs);
    expect(repaired.checkpoint!.slots).toEqual(old.slots);

    const next = runRotate(uni, { ...config, to: axis[60] }, { ...opts, continuation: { capture: true, checkpoint: repaired.checkpoint } });
    expect(next.book.some((row) => row.buys.includes("RTX"))).toBe(false);
    expect(next.checkpoint!.signalTracking!.events.find((event) => event.type === "account_exit"))
      .toMatchObject({ signalId: oldId, entrySignalDate: axis[35], fillDate: axis[52] });
    expect(next.checkpoint!.signalTracking!.events.find((event) => event.type === "buy"))
      .toEqual(old.signalTracking!.events.find((event) => event.type === "buy"));
    expect(rotateCheckpointOf(next.checkpoint)).toBe(next.checkpoint);
  });

  it.each([42, 80])("does not fill a pending order after a delayed historical execution bar, with price drop at %i", (drop) => {
    const clock = symbol("CLOCK", [], prices(80));
    const first = runRotate(universe(clock, symbol("RTX", [35, 46, 53], prices(drop), 36)),
      { ...config, to: axis[50] }, opts);
    const old = structuredClone(first.checkpoint!);
    expect(old.orders).toEqual([{ symbol: "RTX", amount: 1 }]);
    expect(old.signalTracking!.accounts.RTX.legacy).toBe(false);
    const next = runRotate(universe(clock, symbol("RTX", [35, 46, 53], prices(drop))),
      { ...config, to: axis[60] }, { ...opts, continuation: { capture: true, checkpoint: old } });

    expect(next.book.some((row) => row.buys.includes("RTX"))).toBe(false);
    expect(next.checkpoint!.cash).toBe(old.cash);
    expect(next.checkpoint!.orders).toEqual([]);
    expect(next.checkpoint!.signalTracking!.accounts.RTX).toBeUndefined();
    expect(next.checkpoint!.signalTracking!.events.find((event) => event.type === "buy"))
      .toMatchObject({ signalDate: axis[35], status: "skipped", reason: "delayed_quote" });
    expect(old).toEqual(first.checkpoint);
    expect(rotateCheckpointOf(next.checkpoint)).toBe(next.checkpoint);
  });

  it("cancels a delayed pending order at an unchanged cutoff, then restores idempotently", () => {
    const clock = symbol("CLOCK", [], prices(80));
    const first = runRotate(universe(clock, symbol("RTX", [35], prices(80), 36)),
      { ...config, to: axis[50] }, opts);
    const old = structuredClone(first.checkpoint!);
    const uni = universe(clock, symbol("RTX", [35], prices(80)));
    const repaired = runRotate(uni, { ...config, to: axis[50] }, {
      ...opts, continuation: { capture: true, checkpoint: old },
    });
    expect(repaired.book).toEqual([]);
    expect(repaired.trades).toEqual([]);
    expect(repaired.checkpoint).toMatchObject({ cash: old.cash, lastEq: old.lastEq, slots: old.slots,
      totals: old.totals, dailyEquity: old.dailyEquity, legs: {}, orders: [], decisions: {} });
    expect(repaired.checkpoint!.signalTracking!.accounts).toEqual({});
    expect(repaired.checkpoint!.signalTracking!.events).toEqual(old.signalTracking!.events.map((event) =>
      ({ ...event, status: "skipped", reason: "delayed_quote" })));
    const saved = rotateCheckpointOf(JSON.parse(JSON.stringify(repaired.checkpoint)));
    const again = runRotate(uni, { ...config, to: axis[50] }, {
      ...opts, continuation: { capture: true, checkpoint: saved },
    });
    expect(again.checkpoint).toEqual(saved);
    const continued = runRotate(uni, { ...config, to: axis[60] }, {
      ...opts, continuation: { capture: true, checkpoint: saved },
    });
    expect(continued.book.some((row) => row.buys.includes("RTX"))).toBe(false);
    expect(continued.checkpoint!.cash).toBe(old.cash);
    expect(old).toEqual(first.checkpoint);
  });

  it("keeps a genuine halt's pending order when its first subsequent quote is after the cutoff", () => {
    const clock = symbol("CLOCK", [], prices(80));
    const first = runRotate(universe(clock, symbol("RTX", [35], prices(80), 36)),
      { ...config, to: axis[50] }, opts);
    const halted = symbol("RTX", [35], prices(80), 65);
    halted.axisIndex = Int32Array.from(Array.from({ length: 65 }, (_, i) => i <= 35 ? i : i + 15));
    const next = runRotate(universe(clock, halted), { ...config, to: axis[60] }, {
      ...opts, continuation: { capture: true, checkpoint: first.checkpoint },
    });
    expect(next.book.filter((row) => row.buys.includes("RTX")).map((row) => row.date)).toEqual([axis[51]]);
    expect(next.checkpoint!.signalTracking!.events.find((event) => event.type === "buy"))
      .toMatchObject({ signalDate: axis[35], status: "bought", fillDate: axis[51], fillPrice: 100 });
    expect(rotateCheckpointOf(next.checkpoint)).toBe(next.checkpoint);
  });

  it("keeps normal next-bar execution even if that new bar subsequently signals an exit", () => {
    const uni = universe(symbol("RTX", [35], prices(36)));
    const first = runRotate(uni, { ...config, to: axis[35] }, opts);
    const next = runRotate(uni, { ...config, to: axis[40] }, {
      ...opts, continuation: { capture: true, checkpoint: first.checkpoint },
    });
    expect(next.book.filter((row) => row.buys.includes("RTX")).map((row) => row.date)).toEqual([axis[36]]);
    expect(next.checkpoint!.signalTracking!.events.find((event) => event.type === "buy"))
      .toMatchObject({ status: "bought", fillDate: axis[36] });
  });

  it("preserves a pre-migration pending order's existing execution rule", () => {
    const clock = symbol("CLOCK", [], prices(80));
    const first = runRotate(universe(clock, symbol("RTX", [35], prices(80), 36)),
      { ...config, to: axis[50] }, { ...opts, separateSignalState: false });
    const next = runRotate(universe(clock, symbol("RTX", [35], prices(80))),
      { ...config, to: axis[60] }, { ...opts, continuation: { capture: true, checkpoint: first.checkpoint } });
    expect(next.book.filter((row) => row.buys.includes("RTX")).map((row) => row.date)).toEqual([axis[51]]);
    expect(next.checkpoint!.signalTracking!.accounts.RTX).toEqual({ legacy: true, signalId: null });
    expect(next.checkpoint!.signalTracking!.events).toEqual([]);
    expect(rotateCheckpointOf(next.checkpoint)).toBe(next.checkpoint);
  });

  it("does not silently guess the global cutoff for prototype states without per-symbol watermarks", () => {
    const uni = universe(symbol("RTX", [35], prices(80)));
    const first = runRotate(uni, { ...config, to: axis[45] }, opts);
    const old = structuredClone(first.checkpoint!);
    delete old.signalTracking!.states.RTX.lastProcessedDate;
    const saved = JSON.stringify(old);
    expect(rotateCheckpointOf(old)).toBe(old); // Old reports remain readable.
    expect(() => runRotate(uni, config, { ...opts, continuation: { capture: true, checkpoint: old } })).toThrow("逐票 K 线水位");
    expect(JSON.stringify(old)).toBe(saved);
  });

  it("rejects invalid or missing watermark bars while keeping the original account", () => {
    const first = runRotate(universe(symbol("RTX", [35], prices(80))), { ...config, to: axis[45] }, opts);
    const old = structuredClone(first.checkpoint!);
    const bad = structuredClone(old);
    bad.signalTracking!.states.RTX.lastProcessedDate = axis[46];
    expect(() => rotateCheckpointOf(bad)).toThrow("恢复状态无效");
    const saved = JSON.stringify(old);
    expect(() => runRotate(universe(symbol("RTX", [35], prices(80), 40), symbol("CLOCK", [], prices(80))),
      config, { ...opts, continuation: { capture: true, checkpoint: old } })).toThrow("水位与现有行情不一致");
    expect(JSON.stringify(old)).toBe(saved);
  });

  it("does not replay already processed interior history revisions", () => {
    const first = runRotate(universe(symbol("RTX", [35], prices(80))), { ...config, to: axis[50] }, opts);
    const old = structuredClone(first.checkpoint!);
    const revised = prices(80);
    revised[45] = 50;
    const same = runRotate(universe(symbol("RTX", [35, 47], revised)), { ...config, to: axis[50] }, {
      ...opts, continuation: { capture: true, checkpoint: old },
    });
    expect(same.book).toEqual([]);
    expect(same.checkpoint).toEqual(old);
  });
});
