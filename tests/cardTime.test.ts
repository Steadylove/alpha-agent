import { formatEtStamp, formatUtcStamp, withTimeZone } from "@/lib/discord/cardTime";
import { withDisclaimer } from "@/lib/discord/cardDisclaimer";
import { describe, expect, it } from "vitest";

describe("card time", () => {
  it("UTC 墙钟补 UTC，已有时区不重复", () => {
    expect(formatUtcStamp("2026-08-21T17:30")).toBe("2026-08-21 17:30 UTC");
    expect(formatUtcStamp("2026-09-11T02:15:00Z")).toBe("2026-09-11 02:15 UTC");
    expect(formatUtcStamp("2026-09-11 02:15 UTC")).toBe("2026-09-11 02:15 UTC");
    expect(formatUtcStamp("2026-09-09")).toBe("2026-09-09");
    expect(formatEtStamp("2026-09-04T16:14:59")).toBe("2026-09-04 16:14 美东");
    expect(withTimeZone("2026-09-04 16:14 美东", "美东")).toBe("2026-09-04 16:14 美东");
  });
});

describe("card disclaimer", () => {
  it("并进已有文案，不重复", () => {
    expect(withDisclaimer("截至 2026-08-21 17:30 UTC")).toBe(
      "截至 2026-08-21 17:30 UTC · 仅供信息参考，不构成投资建议",
    );
    expect(withDisclaimer("仅供信息参考，不构成投资建议")).toBe("仅供信息参考，不构成投资建议");
  });
});
