import detailFontData from "./fonts/ChakraPetch-glyphs.json";
import wordmarks from "./fonts/report-wordmarks.json";

/** Finished title artwork as paths, so Linux never substitutes the approved italic titles. */
export function reportWordmark(kind: keyof typeof wordmarks, x: number, y: number, size: number, color: string): string {
  const art = wordmarks[kind], scale = size / art.unitsPerEm;
  return `<path d="${art.path}" fill="${color}" transform="translate(${x} ${y}) scale(${scale} ${-scale})"/>`;
}

export const C = {
  bg: "#101114", panel: "#151B1C", panel2: "#14201E", line: "#2B3434",
  white: "#E8ECE9", secondary: "#BCC8C4", muted: "#97A09E",
  accent: "#9ED6BC", green: "#89D6B0", red: "#F59A95", gold: "#DBC08C",
};
export const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
export const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
export const num = (n: number | null | undefined, d = 2) => finite(n) ? n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d }) : "—";
export const signed = (n: number | null | undefined, d = 2, unit = "%") => finite(n) ? `${Math.abs(n) < .5 * 10 ** -d ? "" : n > 0 ? "+" : "−"}${num(Math.abs(n), d)}${unit}` : "—";
export const ink = (n: number | null | undefined) => !finite(n) || Math.abs(n) < .005 ? C.secondary : n >= 0 ? C.green : C.red;
const widthOf = (s: string, size: number) => Array.from(s).reduce((a, c) => a + size * (/[\u0000-\u00ff]/.test(c) ? .60 : 1.025), 0);
const DETAIL_FONT = "Chakra Petch, Hiragino Sans GB, Noto Sans CJK SC, sans-serif";
type OutlineFont = { unitsPerEm: number; capCenter: number; glyphs: Record<string, { advance: number; path: string }> };

export function createReportCanvas(width: number, height: number) {
  const out: string[] = [];
  const glyphDefs = new Map<string, string>();
  const rect = (x: number, y: number, w: number, h: number, fill = C.panel, stroke = C.line, r = 4) =>
    out.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${fill}" stroke="${stroke}"/>`);
  const line = (x: number, y: number, w: number, color = C.line) => out.push(`<path d="M${x} ${y}h${w}" stroke="${color}"/>`);
  const text = (s: string, x: number, y: number, size = 18, color = C.secondary, weight = 400, max = 10000, anchor = "start", mono = false, centerY?: number) => {
    const detail = size <= 18 && !mono;
    if (detail) {
      // Latin outlines avoid silent platform font substitution and align caps to CJK centers.
      const weightKey = weight >= 500 ? "500" : "400";
      const font = detailFontData[weightKey] as OutlineFont;
      const chars = Array.from(s), tracking = .025;
      const units = chars.reduce((sum, ch) => sum + (font.glyphs[ch]?.advance ?? font.unitsPerEm) / font.unitsPerEm + tracking, 0) - tracking;
      const fit = Math.min(size, max / Math.max(units, 1));
      const center = centerY ?? y - size * .38;
      let cursor = x - units * fit * (anchor === "end" ? 1 : anchor === "middle" ? .5 : 0);
      out.push(`<g fill="${color}" aria-label="${esc(s)}">`);
      for (const ch of chars) {
        const glyph = font.glyphs[ch];
        if (glyph) {
          const id = `detail-${weightKey}-${ch.codePointAt(0)!.toString(16)}`;
          if (glyph.path) {
            glyphDefs.set(id, `<path id="${id}" d="${glyph.path}"/>`);
            const scale = fit / font.unitsPerEm;
            out.push(`<use href="#${id}" transform="translate(${cursor} ${center + font.capCenter * scale}) scale(${scale} ${-scale})"/>`);
          }
          cursor += (glyph.advance / font.unitsPerEm + tracking) * fit;
        } else {
          out.push(`<text x="${cursor}" y="${center}" dominant-baseline="central" font-size="${fit}" font-weight="400" font-family="Hiragino Sans GB, Noto Sans CJK SC, sans-serif">${esc(ch)}</text>`);
          cursor += (1 + tracking) * fit;
        }
      }
      out.push("</g>");
      return;
    }
    const fit = Math.min(size, size * max / Math.max(widthOf(s, size), 1));
    const font = mono ? "Menlo, monospace" : detail ? DETAIL_FONT : "Avenir Next, PingFang SC, Noto Sans CJK SC, sans-serif";
    out.push(`<text xml:space="preserve" x="${x}" y="${centerY ?? y}"${centerY != null ? ' dominant-baseline="central" alignment-baseline="central"' : ""} font-size="${fit}" font-weight="${weight}" fill="${color}" text-anchor="${anchor}" font-family="${font}">${esc(s)}</text>`);
  };
  const paragraph = (s: string, x: number, y: number, max: number, size = 18, color = C.secondary, limit = 3) => {
    const lines: string[] = []; let row = "";
    // Keep tickers, dates, and numeric values together when wrapping CJK text.
    for (const c of s.match(/[A-Za-z0-9][A-Za-z0-9.%/+−-]*|\s+|./gu) ?? []) {
      if (row && widthOf(row + c, size) > max && !/^[，。；：！？、）]/u.test(c)) { lines.push(row); row = ""; }
      if (row || c.trim()) row += c;
    }
    if (row) lines.push(row);
    lines.slice(0, limit).forEach((value, i) => text(i === limit - 1 && lines.length > limit ? value.slice(0, -1) + "…" : value, x, y + i * (size + 10), size, color));
  };
  const pill = (s: string, x: number, y: number, color: string, max = 180) => {
    const w = Math.min(widthOf(s, 15) + 22, max);
    rect(x, y, w, 28, C.panel2, C.line, 4);
    text(s, x + w / 2, y + 19, 15, color, 500, w - 16, "middle", false, y + 14);
    return w;
  };
  const section = (index: string, title: string, en: string, y: number, detail: string) => {
    const center = y - 9;
    text(index, 48, y, 22, C.accent, 700, 50, "start", true, center);
    text(title, 100, y, 26, C.white, 600, 10000, "start", false, center);
    text(en, 100 + widthOf(title, 26) + 24, y, 18, C.muted, 500, 10000, "start", false, center);
    text(detail, 1872, y, 16, C.muted, 400, 740, "end", false, center);
  };
  const finish = () => `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><defs>${[...glyphDefs.values()].join("")}</defs>${out.join("\n")}</svg>`;
  return { out, rect, line, text, paragraph, pill, section, finish };
}
