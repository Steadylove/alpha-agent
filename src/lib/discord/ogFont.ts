import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const OG_FONT = "Noto Sans SC";
export const SIGNAL_NUMBER_FONT = "IBM Plex Mono";

const FONT_UA =
  "Mozilla/5.0 (Macintosh; U; Intel Mac OS X 10_6_8; de-at) AppleWebKit/533.21.1 (KHTML, like Gecko) Version/5.0.5 Safari/533.21.1";
const FONT_DIR = join(tmpdir(), "alpha-agent-og-fonts");
const fontCache = new Map<string, Promise<{ name: string; data: ArrayBuffer; weight: 400 | 700 }[]>>();

export type OgFontFace = { name: string; data: ArrayBuffer; weight: 400 | 700 };

function uniqueGlyphs(text: string): string {
  return Array.from(new Set(`${text}0123456789.+-%·— `)).sort().join("");
}

export async function loadOgFonts(text: string): Promise<OgFontFace[]> {
  const unique = uniqueGlyphs(text);
  const hit = fontCache.get(unique);
  if (hit) return hit;
  const pending = Promise.all([loadWeight(unique, 400), loadWeight(unique, 700)]).then(([regular, bold]) => [
    { name: OG_FONT, data: regular, weight: 400 as const },
    { name: OG_FONT, data: bold, weight: 700 as const },
  ]);
  fontCache.set(unique, pending);
  pending.catch(() => fontCache.delete(unique));
  return pending;
}

export async function loadSignalNumberFont(text: string) {
  const subset = Array.from(new Set(text.replace(/[^\x20-\x7E]/g, "") + "0123456789.+-%/$")).join("");
  return { name: SIGNAL_NUMBER_FONT, data: await loadWeight(subset, 700, SIGNAL_NUMBER_FONT, AbortSignal.timeout(2500)), weight: 700 as const };
}

export function injectSvgFontFace(svg: string, fonts: readonly OgFontFace[]): string {
  mkdirSync(FONT_DIR, { recursive: true });
  const css = fonts
    .map((font) => {
      const hash = createHash("sha1").update(Buffer.from(font.data)).digest("hex").slice(0, 12);
      const file = join(FONT_DIR, `${font.name.replace(/\s+/g, "")}-${font.weight}-${hash}.ttf`);
      writeFileSync(file, Buffer.from(font.data));
      const href = file.replace(/\\/g, "/");
      return `@font-face{font-family:'${font.name}';font-weight:${font.weight};font-style:normal;src:url('file://${href}') format('truetype');}`;
    })
    .join("");
  return svg.replace(/<svg\b([^>]*)>/i, `<svg$1><defs><style type="text/css">${css}</style></defs>`);
}

export async function withOgFontFace(svg: string): Promise<string> {
  const text = svg.replace(/<[^>]+>/g, " ").replace(/&(?:amp|lt|gt|quot);/g, " ");
  return injectSvgFontFace(svg, await loadOgFonts(text));
}

async function loadWeight(text: string, weight: 400 | 700, family = OG_FONT, signal?: AbortSignal): Promise<ArrayBuffer> {
  const cssUrl = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family)}:wght@${weight}&text=${encodeURIComponent(text)}`;
  const css = await fetch(cssUrl, { headers: { "User-Agent": FONT_UA }, signal }).then((res) => {
    if (!res.ok) throw new Error(`字体 CSS ${res.status}`);
    return res.text();
  });
  const match = css.match(/src:\s*url\(([^)]+)\)/);
  if (!match) throw new Error("字体 CSS 没有 src");
  const res = await fetch(match[1].replace(/['"]/g, ""), { signal });
  if (!res.ok) throw new Error(`字体文件 ${res.status}`);
  return res.arrayBuffer();
}
