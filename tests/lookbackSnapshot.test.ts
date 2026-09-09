import { describe, expect, it } from "vitest";

import {
  addSnapshot,
  defaultSnapshotName,
  removeSnapshot,
  renameSnapshot,
  snapshotListOf,
  snapshotOf,
} from "@/lib/fund/lookbackSnapshotLogic";

const base = {
  members: ["NVDA", "AAPL"],
  tf: "4h" as const,
  from: "2026-01-01",
  slots: 10,
  pnl: "+12.3%",
  equity: 1.123,
  cagr: 18.2,
  dd: 11,
  mar: 1.65,
};

describe("lookback snapshot", () => {
  it("缺名单或起点就不收", () => {
    expect(snapshotOf({ ...base, members: [] })).toBeNull();
    expect(snapshotOf({ ...base, from: "yesterday" })).toBeNull();
    expect(snapshotOf({ ...base, tf: "1d" })).toBeNull();
  });

  it("没写名字就用起点、只数和收益", () => {
    expect(defaultSnapshotName(base)).toBe("2026-01-01 · 2只 · 4h · +12.3%");
    expect(snapshotOf(base)?.name).toBe("2026-01-01 · 2只 · 4h · +12.3%");
    expect(snapshotOf({ ...base, name: "  半导体  " })?.name).toBe("半导体");
  });

  it("新快照插到最前，最多 40 条", () => {
    const first = addSnapshot([], base, new Date("2026-09-07T03:00:00Z"));
    expect(first).toHaveLength(1);
    expect(first[0].members).toEqual(["AAPL", "NVDA"]);
    const second = addSnapshot(first, { ...base, name: "第二份", pnl: "+9%" }, new Date("2026-09-07T04:00:00Z"));
    expect(second.map((s) => s.name)).toEqual(["第二份", first[0].name]);
    expect(removeSnapshot(second, second[0].id)).toEqual(first);
  });

  it("可以改名，空名不行", () => {
    const list = addSnapshot([], { ...base, name: "旧名" }, new Date("2026-09-07T03:00:00Z"));
    expect(renameSnapshot(list, list[0].id, "  半导体  ")[0].name).toBe("半导体");
    expect(() => renameSnapshot(list, list[0].id, "  ")).toThrow("名字不能空");
    expect(() => renameSnapshot(list, "nope", "x")).toThrow("没有这条快照");
  });

  it("坏文件当空列表", () => {
    expect(snapshotListOf(null)).toEqual([]);
    expect(snapshotListOf([{ members: ["??"] }])).toEqual([]);
  });
});
