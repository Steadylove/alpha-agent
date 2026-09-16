import { expect, it } from "vitest";

import { injectSvgFontFace, OG_FONT } from "@/lib/discord/ogFont";

it("把字体文件写进 SVG @font-face，供 Sharp 在无系统中文字体时出图", () => {
  const svg = injectSvgFontFace(`<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>`, [
    { name: OG_FONT, data: new TextEncoder().encode("font").buffer, weight: 400 },
  ]);
  expect(svg).toContain("@font-face");
  expect(svg).toContain("font-family:'Noto Sans SC'");
  expect(svg).toContain("file://");
  expect(svg).toMatch(/<svg[^>]*><defs><style/);
});
