import sharp from "sharp";

export const FONT = "PingFang SC, Hiragino Sans GB, Noto Sans CJK SC, Microsoft YaHei, sans-serif";
export const MONO = "SF Mono, Menlo, Consolas, Trebuchet MS, monospace";
export const SCALE = 2;

/** 交易终端 HUD：深底高对比，不用紫粉渐变。 */
export const T = {
  bg: "#020617",
  panel: "#0B1220",
  panelAlt: "#111827",
  line: "#1E293B",
  grid: "#0F172A",
  text: "#F8FAFC",
  muted: "#64748B",
  dim: "#94A3B8",
  buy: "#22C55E",
  take: "#F59E0B",
  stop: "#F43F5E",
  sell: "#94A3B8",
  cyan: "#22D3EE",
} as const;

export function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function svgToPng(svg: string, width: number): Promise<Buffer> {
  return sharp(Buffer.from(svg))
    .resize({ width: width * SCALE, kernel: "lanczos3" })
    .png({ compressionLevel: 8, quality: 100 })
    .toBuffer();
}

function corner(x: number, y: number, dx: number, dy: number, color: string): string {
  const s = 16;
  return `<polyline points="${x + dx * s},${y} ${x},${y} ${x},${y + dy * s}" fill="none" stroke="${color}" stroke-width="2"/>`;
}

export function hudBackdrop(w: number, h: number, accent: string): string {
  return `
  <defs>
    <pattern id="hudGrid" width="32" height="32" patternUnits="userSpaceOnUse">
      <path d="M 32 0 L 0 0 0 32" fill="none" stroke="${T.grid}" stroke-width="1"/>
    </pattern>
  </defs>
  <rect width="${w}" height="${h}" fill="${T.bg}"/>
  <rect width="${w}" height="${h}" fill="url(#hudGrid)"/>
  <rect x="0" y="0" width="${w}" height="3" fill="${accent}"/>
  <rect x="0" y="0" width="3" height="${h}" fill="${accent}"/>
  ${corner(14, 14, 1, 1, accent)}
  ${corner(w - 14, 14, -1, 1, accent)}
  ${corner(14, h - 14, 1, -1, accent)}
  ${corner(w - 14, h - 14, -1, -1, accent)}
`;
}

export function hudHeader(w: number, brand: string, title: string, meta: string, accent: string): string {
  return `
  <text x="32" y="42" font-size="13" fill="${accent}" font-family="${MONO}">${esc(brand)}</text>
  <text x="108" y="42" font-size="16" font-weight="bold" fill="${T.text}" font-family="${FONT}">${esc(title)}</text>
  <text x="${w - 32}" y="42" font-size="13" fill="${T.muted}" text-anchor="end" font-family="${MONO}">${esc(meta)}</text>
  <line x1="32" y1="56" x2="${w - 32}" y2="56" stroke="${T.line}" stroke-width="1"/>
`;
}

export function metricTile(
  x: number,
  y: number,
  w: number,
  h: number,
  label: string,
  value: string,
  sub: string | undefined,
  valueColor = T.text,
): string {
  return `
  <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="4" fill="${T.panel}" stroke="${T.line}" stroke-width="1"/>
  <rect x="${x}" y="${y}" width="3" height="${h}" rx="1" fill="${valueColor}"/>
  <text x="${x + 16}" y="${y + 22}" font-size="11" fill="${T.muted}" font-family="${FONT}">${esc(label)}</text>
  <text x="${x + 16}" y="${y + (sub ? 48 : 52)}" font-size="22" font-weight="bold" fill="${valueColor}" font-family="${MONO}">${esc(value)}</text>
  ${sub ? `<text x="${x + 16}" y="${y + h - 14}" font-size="12" fill="${T.dim}" font-family="${MONO}">${esc(sub)}</text>` : ""}
`;
}
