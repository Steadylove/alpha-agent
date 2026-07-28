import sharp from "sharp";
import type { ScreenerResult, ScreenerRow } from "@/lib/jobs/alphaScreener";

/** 一张图展示，金融终端数据表风格（TradingView / Bloomberg 风格），极简、高密度、对齐 */
const WIDTH = 840;
const SCALE = 2; // 1680px 足够清晰，避免长图高度超出限制
const ROW_H = 56;
const HEADER_H = 110;

const FONT = "PingFang SC, Hiragino Sans GB, Noto Sans CJK SC, Microsoft YaHei, sans-serif";
const MONO = "SF Mono, Menlo, Consolas, Trebuchet MS, monospace";

// 金融终端深色主题 (TradingView Dark 变体)
const C = {
  bg: "#131722",
  rowEven: "#131722",
  rowOdd: "#181C25",
  overlapRow: "#13231F",
  overlapLine: "#26A69A",
  overlapBadgeBg: "#1F3B34",
  overlapBadgeText: "#7EE7D2",
  border: "#2A2E39",
  title: "#D1D4DC",
  subtitle: "#787B86",
  colHeader: "#787B86",
  rank: "#787B86",
  symbol: "#E2E8F0",
  industry: "#B2B5BE",
  rpsVal: "#26A69A", // 经典的金融涨色
};

// 列的 X 坐标 (文本左对齐，数字右对齐)
const COL = {
  rank: 48,
  symbol: 96,
  industry: 220,
  rps20: 480,
  rps50: 590,
  rps120: 700,
  rps250: 810,
};

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function displayWidth(s: string): number {
  return Array.from(s).reduce((sum, ch) => (ch.charCodeAt(0) > 127 ? sum + 2 : sum + 1), 0);
}

function truncateLabel(s: string, maxWidth = 28): string {
  const text = s.trim();
  if (displayWidth(text) <= maxWidth) return text;

  let out = "";
  let width = 0;
  for (const ch of text) {
    const w = ch.charCodeAt(0) > 127 ? 2 : 1;
    if (width + w > maxWidth - 1) break;
    out += ch;
    width += w;
  }
  return `${out.trimEnd()}…`;
}

function rowSvg(row: ScreenerRow, index: number, y: number, isOverlap: boolean): string {
  const bg = isOverlap ? C.overlapRow : index % 2 === 0 ? C.rowEven : C.rowOdd;
  const rankStr = String(index + 1).padStart(2, "0");
  const industryLabel = truncateLabel(row.industryLabel);
  const overlapBadge = isOverlap
    ? `<rect x="156" y="${y + 18}" width="42" height="20" rx="4" fill="${C.overlapBadgeBg}" stroke="${C.overlapLine}" stroke-width="1"/>
  <text x="177" y="${y + 32}" font-size="10" font-weight="700" fill="${C.overlapBadgeText}" text-anchor="middle" font-family="${MONO}">BOTH</text>`
    : "";

  return `
  <rect x="0" y="${y}" width="${WIDTH}" height="${ROW_H}" fill="${bg}" />
  ${isOverlap ? `<rect x="0" y="${y}" width="4" height="${ROW_H}" fill="${C.overlapLine}" />` : ""}
  <text x="${COL.rank}" y="${y + 34}" font-size="14" fill="${C.rank}" text-anchor="middle" font-family="${MONO}">${rankStr}</text>
  <text x="${COL.symbol}" y="${y + 35}" font-size="18" font-weight="bold" fill="${C.symbol}" font-family="${MONO}">${esc(row.symbol)}</text>
  ${overlapBadge}
  <text x="${COL.industry}" y="${y + 34}" font-size="14" fill="${C.industry}" font-family="${FONT}">${esc(industryLabel)}</text>

  <text x="${COL.rps20}" y="${y + 35}" font-size="18" font-weight="bold" fill="${C.rpsVal}" text-anchor="end" font-family="${MONO}">${Math.round(row.rps[20])}</text>
  <text x="${COL.rps50}" y="${y + 35}" font-size="18" font-weight="bold" fill="${C.rpsVal}" text-anchor="end" font-family="${MONO}">${Math.round(row.rps[50])}</text>
  <text x="${COL.rps120}" y="${y + 35}" font-size="18" font-weight="bold" fill="${C.rpsVal}" text-anchor="end" font-family="${MONO}">${Math.round(row.rps[120])}</text>
  <text x="${COL.rps250}" y="${y + 35}" font-size="18" font-weight="bold" fill="${C.rpsVal}" text-anchor="end" font-family="${MONO}">${Math.round(row.rps[250])}</text>
  <line x1="0" y1="${y + ROW_H}" x2="${WIDTH}" y2="${y + ROW_H}" stroke="${C.border}" stroke-width="1" />
`;
}

/** 高清深色 PNG：仅数据，无品牌 */
export async function renderScreenerCardPng(
  result: ScreenerResult,
  rows: ScreenerRow[],
  title: string,
  subtitleInfo: string,
  options: { overlapSymbols?: Set<string> } = {},
): Promise<Buffer> {
  const height = HEADER_H + Math.max(rows.length, 1) * ROW_H;

  const body =
    rows.length === 0
      ? `<text x="${WIDTH / 2}" y="${HEADER_H + 60}" font-size="16" fill="${C.subtitle}" text-anchor="middle" font-family="${FONT}">今日无命中</text>`
      : rows
          .map((row, i) =>
            rowSvg(row, i, HEADER_H + i * ROW_H, options.overlapSymbols?.has(row.symbol) ?? false),
          )
          .join("\n");

  const colHeaders = `
  <rect x="0" y="70" width="${WIDTH}" height="40" fill="${C.rowEven}" />
  <line x1="0" y1="110" x2="${WIDTH}" y2="110" stroke="${C.border}" stroke-width="1" />
  <text x="${COL.rank}" y="95" font-size="13" fill="${C.colHeader}" text-anchor="middle" font-family="${FONT}">排名</text>
  <text x="${COL.symbol}" y="95" font-size="13" fill="${C.colHeader}" font-family="${FONT}">代码</text>
  <text x="${COL.industry}" y="95" font-size="13" fill="${C.colHeader}" font-family="${FONT}">行业</text>
  <text x="${COL.rps20}" y="95" font-size="13" fill="${C.colHeader}" text-anchor="end" font-family="${FONT}">RPS 20</text>
  <text x="${COL.rps50}" y="95" font-size="13" fill="${C.colHeader}" text-anchor="end" font-family="${FONT}">RPS 50</text>
  <text x="${COL.rps120}" y="95" font-size="13" fill="${C.colHeader}" text-anchor="end" font-family="${FONT}">RPS 120</text>
  <text x="${COL.rps250}" y="95" font-size="13" fill="${C.colHeader}" text-anchor="end" font-family="${FONT}">RPS 250</text>
  `;

  const titleSvg = `
  <text x="32" y="44" font-size="22" font-weight="bold" fill="${C.title}" font-family="${MONO}">MARKET COMPASS</text>
  <text x="230" y="42" font-size="14" fill="${C.subtitle}" font-family="${FONT}">${title}</text>
  <text x="${WIDTH - 32}" y="43" font-size="14" fill="${C.subtitle}" text-anchor="end" font-family="${MONO}">${subtitleInfo}</text>
  `;

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${WIDTH}" height="${height}" viewBox="0 0 ${WIDTH} ${height}" xmlns="http://www.w3.org/2000/svg">
  <rect width="100%" height="100%" fill="${C.bg}"/>
  ${titleSvg}
  ${colHeaders}
  ${body}
</svg>`;

  return sharp(Buffer.from(svg))
    .resize({ width: WIDTH * SCALE, kernel: "lanczos3" })
    .png({ compressionLevel: 8, quality: 100 })
    .toBuffer();
}
