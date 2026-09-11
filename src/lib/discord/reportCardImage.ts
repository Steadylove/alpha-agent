import { CARD_INK, CARD_SCALE } from "./cardTheme";
import type { ReportCardLayout } from "./reportCardLayout";
import { esc, FONT, MONO, svgToPng } from "./terminalTheme";

export function reportCardSvg(layout: ReportCardLayout): string {
  const body = layout.items.map((item) => {
    if (item.type === "rect") return `<rect x="${item.x}" y="${item.y}" width="${item.width}" height="${item.height}" rx="${item.radius}" fill="${item.fill}"${item.stroke ? ` stroke="${item.stroke}"` : ""}/>`;
    if (item.type === "path") return `<path transform="translate(${item.x},${item.y})" d="${item.d}" fill="none" stroke="${item.color}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>`;
    const x = item.x + (item.align === "right" ? item.width : item.align === "center" ? item.width / 2 : 0);
    const anchor = item.align === "right" ? "end" : item.align === "center" ? "middle" : "start";
    return `<text x="${x}" y="${item.y + item.height / 2 + item.size * .35}" font-size="${item.size}" font-weight="${item.weight}" fill="${item.color}" text-anchor="${anchor}" font-family="${item.numeric ? MONO : FONT}">${esc(item.text)}</text>`;
  }).join("\n");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${layout.width * CARD_SCALE}" height="${layout.height * CARD_SCALE}" viewBox="0 0 ${layout.width} ${layout.height}"><rect width="${layout.width}" height="${layout.height}" fill="${CARD_INK.bg}"/>${body}</svg>`;
}

export function renderReportCardPng(layout: ReportCardLayout): Promise<Buffer> {
  return svgToPng(reportCardSvg(layout), layout.width);
}
