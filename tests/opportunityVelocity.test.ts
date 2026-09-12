import { rpsDelta } from "@/lib/opportunity/velocityOf";
import { describe, expect, it } from "vitest";

describe("rpsDelta", () => {
  it("今日减 T-5", () => {
    expect(rpsDelta(88, 80)).toBe(8);
    expect(rpsDelta(70, 80)).toBe(-10);
  });

  it("缺一侧则为空", () => {
    expect(rpsDelta(88, null)).toBeNull();
    expect(rpsDelta(null, 80)).toBeNull();
    expect(rpsDelta(undefined, 80)).toBeNull();
  });
});
