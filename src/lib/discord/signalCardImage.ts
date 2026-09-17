import { FONT, MONO, esc, svgToPng } from "./terminalTheme";
import { signalCardLayout, SIGNAL_CARD_SCALE, SIGNAL_INK } from "./signalCardLayout";
import { signalTradeChartSvg } from "./signalTradeChart";
import type { AlertView } from "./tvAlertCopy";

/** 可编辑矢量预览与线上 OG 来自同一份布局。 */
export function signalCardSvg(view: AlertView): string {
  const layout = signalCardLayout(view), scale = SIGNAL_CARD_SCALE;
  const body = layout.items.map((item) => {
    if (item.type === "chart") return `<g transform="translate(${item.x},${item.y})">${signalTradeChartSvg(item.chart)}</g>`;
    if (item.type === "rect") return `<rect x="${item.x}" y="${item.y}" width="${item.width}" height="${item.height}" rx="${item.radius ?? 0}" fill="${item.fill}"${item.stroke ? ` stroke="${item.stroke}"` : ""}/>`;
    const x = item.x + (item.align === "right" ? item.width : item.align === "center" ? item.width / 2 : 0);
    const anchor = item.align === "right" ? "end" : item.align === "center" ? "middle" : "start";
    return `<text x="${x}" y="${item.y + item.height / 2 + item.size * .35}" font-size="${item.size}" font-weight="${item.weight}" fill="${item.color}" text-anchor="${anchor}" font-family="${item.numeric ? MONO : FONT}">${esc(item.text)}</text>`;
  }).join("\n");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${layout.width * scale}" height="${layout.height * scale}" viewBox="0 0 ${layout.width} ${layout.height}"><rect width="${layout.width}" height="${layout.height}" fill="${SIGNAL_INK.bg}"/>${body}</svg>`;
}

export function renderSignalPng(view: AlertView): Promise<Buffer> {
  return svgToPng(signalCardSvg(view), signalCardLayout(view).width);
}
