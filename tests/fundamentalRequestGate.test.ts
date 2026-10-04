import { afterEach, describe, expect, it, vi } from "vitest";
import { createFundamentalRequestGate } from "@/lib/fundamental/requestGate";

afterEach(() => vi.useRealTimers());

describe("fundamental request pacing", () => {
  it("spaces concurrent starts and allows an immediate first request", async () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    const gate = createFundamentalRequestGate(), starts: number[] = [];
    const pending = Promise.all(Array.from({ length: 4 }, () => gate(() => { starts.push(Date.now()); })));
    await vi.runAllTimersAsync();
    await pending;
    expect(starts).toEqual([0, 1000, 2000, 3000]);
  });

  it("does not wait again after a naturally idle interval", async () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    const gate = createFundamentalRequestGate();
    await gate(() => undefined);
    await vi.advanceTimersByTimeAsync(5000);
    const check = vi.fn();
    await gate(check);
    expect(check).toHaveBeenCalledOnce();
    expect(Date.now()).toBe(5000);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("checks a queued request after waiting and does not poison the queue on rejection", async () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    const gate = createFundamentalRequestGate();
    await gate(() => undefined);
    let stopped = false;
    const rejected = gate(() => { if (stopped) throw new Error("rate limited"); });
    const expectation = expect(rejected).rejects.toThrow("rate limited");
    stopped = true;
    await vi.runAllTimersAsync();
    await expectation;
    const start = vi.fn();
    await gate(start);
    expect(start).toHaveBeenCalledOnce();
    expect(Date.now()).toBe(1000);
  });

  it("supports an explicit zero interval and rejects invalid settings", async () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    const gate = createFundamentalRequestGate(0), check = vi.fn();
    await Promise.all([gate(check), gate(check)]);
    expect(check).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
    for (const value of [-1, NaN, Infinity, 0.5, 60001])
      expect(() => createFundamentalRequestGate(value)).toThrow("request interval");
  });
});
