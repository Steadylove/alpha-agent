import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { readSignalPool, readSignalPoolMembers, writeSignalPool } from "@/lib/fund/signalPool";
import {
  applySignalPool,
  baseOfPool,
  editSignalPool,
  editSignalPoolMany,
  emptySignalPool,
  isTickerInPool,
  normalizeTicker,
  parseTickers,
  replaceSignalPool,
  signalPoolOf,
  tickerListOf,
} from "@/lib/fund/signalPoolLogic";

const BASE = ["AAPL", "MSFT", "NVDA"];

describe("signal pool", () => {
  const prev = process.env.SIGNAL_POOL_PATH;
  afterEach(() => {
    if (prev == null) delete process.env.SIGNAL_POOL_PATH;
    else process.env.SIGNAL_POOL_PATH = prev;
  });

  it("代码去交易所前缀", () => {
    expect(normalizeTicker("nvda")).toBe("NVDA");
    expect(normalizeTicker("NASDAQ:NVDA")).toBe("NVDA");
    expect(normalizeTicker("BRK.B")).toBe("BRK.B");
    expect(normalizeTicker("??")).toBeNull();
  });

  it("缺补丁就是默认 560 基线", () => {
    expect(applySignalPool(BASE, emptySignalPool())).toEqual(BASE);
    expect(signalPoolOf(null)).toEqual(emptySignalPool());
  });

  it("剔除基线票、纳入新票、再纳回等于撤销剔除", () => {
    const cut = editSignalPool(BASE, emptySignalPool(), "remove", "AAPL");
    expect(applySignalPool(BASE, cut)).toEqual(["MSFT", "NVDA"]);

    const extra = editSignalPool(BASE, cut, "add", "XYZ");
    expect(applySignalPool(BASE, extra)).toEqual(["MSFT", "NVDA", "XYZ"]);

    const back = editSignalPool(BASE, extra, "add", "AAPL");
    expect(back.removed).toEqual([]);
    expect(applySignalPool(BASE, back)).toEqual(["AAPL", "MSFT", "NVDA", "XYZ"]);
  });

  it("重复加减要报错", () => {
    expect(() => editSignalPool(BASE, emptySignalPool(), "add", "NVDA")).toThrow("已在池里");
    expect(() => editSignalPool(BASE, emptySignalPool(), "remove", "XYZ")).toThrow("不在池里");
  });

  it("推信号只认池内代码", () => {
    const members = applySignalPool(BASE, editSignalPool(BASE, emptySignalPool(), "remove", "AAPL"));
    expect(isTickerInPool("NASDAQ:MSFT", members)).toBe(true);
    expect(isTickerInPool("AAPL", members)).toBe(false);
  });

  it("写盘后推账本读到同一份名单", async () => {
    process.env.SIGNAL_POOL_PATH = path.join(mkdtempSync(path.join(tmpdir(), "pool-")), "signal-pool.json");
    await writeSignalPool(editSignalPool(BASE, emptySignalPool(), "remove", "MSFT"), new Date("2026-09-06T11:00:00Z"));
    expect((await readSignalPool()).removed).toEqual(["MSFT"]);
    expect(await readSignalPoolMembers(BASE)).toEqual(["AAPL", "NVDA"]);
  });

  it("批量粘贴拆代码，非法的单独列出", () => {
    expect(parseTickers("nvda, AAPL\nNASDAQ:MSFT  ??  BRK.B")).toEqual({
      ok: ["NVDA", "AAPL", "MSFT", "BRK.B"],
      bad: ["??"],
    });
  });

  it("replace 用目标名单生成 added/removed", () => {
    const patch = replaceSignalPool(BASE, ["NVDA", "XYZ"]);
    expect(patch.added).toEqual(["XYZ"]);
    expect(patch.removed).toEqual(["AAPL", "MSFT"]);
    expect(patch.members).toEqual(["NVDA", "XYZ"]);
    expect(applySignalPool(BASE, patch)).toEqual(["NVDA", "XYZ"]);
  });

  it("记下名单后默认池再扩也不漏进新票", () => {
    const grown = [...BASE, "TSLA", "META"];
    const stale = { added: [] as string[], removed: ["AAPL"], updatedAt: "" };
    expect(applySignalPool(grown, stale)).toEqual(["META", "MSFT", "NVDA", "TSLA"]);
    const pinned = replaceSignalPool(BASE, ["MSFT", "NVDA"]);
    expect(applySignalPool(grown, pinned)).toEqual(["MSFT", "NVDA"]);
  });

  it("批量加减跳过已经对上的票", () => {
    const next = editSignalPoolMany(BASE, emptySignalPool(), "remove", ["AAPL", "AAPL", "NOPE"]);
    expect(applySignalPool(BASE, next)).toEqual(["MSFT", "NVDA"]);
  });

  it("接口名单还原默认基线", () => {
    expect(
      baseOfPool({ members: ["MSFT", "NVDA", "XYZ"], added: ["XYZ"], removed: ["AAPL"] }),
    ).toEqual(["AAPL", "MSFT", "NVDA"]);
  });

  it("回看可传显式名单，空数组就是空池", () => {
    expect(tickerListOf(["nvda", "NASDAQ:AAPL", "??"])).toEqual(["AAPL", "NVDA"]);
    expect(tickerListOf([])).toEqual([]);
    expect(tickerListOf(null)).toBeUndefined();
  });
});
