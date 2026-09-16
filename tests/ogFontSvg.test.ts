import { expect, it } from "vitest";

import { injectSvgFontFace, OG_FONT } from "@/lib/discord/ogFont";

it("把 Noto 子集交给 fontconfig，并保留 SVG @font-face 给 macOS", () => {
  const svg = injectSvgFontFace(`<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>`, [
    { name: OG_FONT, data: new TextEncoder().encode("font").buffer, weight: 400 },
  ]);
  expect(svg).toContain("@font-face");
  expect(svg).toContain("font-family:'Noto Sans SC'");
  expect(process.env.FONTCONFIG_FILE).toMatch(/fonts\.conf$/);
});
