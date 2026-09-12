import { formatBeijingFromUtc, formatEtFromUtc, formatEtStamp, withTimeZone } from "@/lib/discord/cardTime";
import { withDisclaimer } from "@/lib/discord/cardDisclaimer";
import { describe, expect, it } from "vitest";

describe("card time", () => {
  it("UTC 账本时刻换成美东时间", () => {
    expect(formatEtFromUtc("2026-08-21T17:30")).toBe("2026-08-21 13:30 美东时间");
    expect(formatEtFromUtc("2026-01-15T17:30")).toBe("2026-01-15 12:30 美东时间");
    expect(formatEtFromUtc("2026-09-09")).toBe("2026-09-09");
  });

  it("Discord 时间戳换成北京时间", () => {
    expect(formatBeijingFromUtc("2026-09-11T02:15:00Z")).toBe("2026-09-11 10:15 北京时间");
  });

  it("已是美东墙钟的快照只补时区名", () => {
    expect(formatEtStamp("2026-09-04T16:14:59")).toBe("2026-09-04 16:14 美东时间");
    expect(withTimeZone("2026-09-04 16:14 美东时间", "美东时间")).toBe("2026-09-04 16:14 美东时间");
  });
});

describe("card disclaimer", () => {
  it("并进已有文案，不重复", () => {
    expect(withDisclaimer("截至 2026-08-21 13:30 美东时间")).toBe(
      "截至 2026-08-21 13:30 美东时间 · 仅供信息参考，不构成投资建议",
    );
    expect(withDisclaimer("仅供信息参考，不构成投资建议")).toBe("仅供信息参考，不构成投资建议");
  });
});
