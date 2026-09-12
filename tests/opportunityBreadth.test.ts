import { breadthOf } from "@/lib/opportunity/breadthOf";
import { describe, expect, it } from "vitest";

describe("breadthOf", () => {
  it("按档统计样本、强势、抬头", () => {
    const rows = [
      ...Array.from({ length: 4 }, () => ({ sectorId: "TECH" as const, rps250: 85, rpsDelta: 1 })),
      ...Array.from({ length: 3 }, () => ({ sectorId: "TECH" as const, rps250: 70, rpsDelta: 2 })),
      ...Array.from({ length: 3 }, () => ({ sectorId: "TECH" as const, rps250: 60, rpsDelta: -1 })),
    ];
    expect(breadthOf(rows).TECH).toEqual({ sample: 10, strong: 4, rising: 7 });
  });

  it("未分类不进 11 档", () => {
    expect(breadthOf([{ sectorId: null, rps250: 90, rpsDelta: 3 }])).toEqual({});
  });
});
