import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { readBookEpoch, resetBookEpoch } from "@/lib/fund/bookEpoch";
import { bookEpochOf, normalizeBookFrom } from "@/lib/fund/bookEpochLogic";

describe("book epoch", () => {
  const prev = process.env.BOOK_EPOCH_PATH;
  afterEach(() => {
    if (prev == null) delete process.env.BOOK_EPOCH_PATH;
    else process.env.BOOK_EPOCH_PATH = prev;
  });

  it("只接受日历日", () => {
    expect(normalizeBookFrom("2026-09-04")).toBe("2026-09-04");
    expect(normalizeBookFrom("2026-09-04T17:30")).toBe("2026-09-04");
    expect(normalizeBookFrom("9/4")).toBeNull();
  });

  it("缺文件回落到五年窗起点", () => {
    expect(bookEpochOf(null, "2021-08-24")).toEqual({ from: "2021-08-24", resetAt: "" });
  });

  it("重置后推账本读到新起点", () => {
    process.env.BOOK_EPOCH_PATH = path.join(mkdtempSync(path.join(tmpdir(), "epoch-")), "book-epoch.json");
    const epoch = resetBookEpoch("2026-09-04", new Date("2026-09-06T10:00:00Z"));
    expect(epoch.from).toBe("2026-09-04");
    expect(readBookEpoch().from).toBe("2026-09-04");
  });
});
