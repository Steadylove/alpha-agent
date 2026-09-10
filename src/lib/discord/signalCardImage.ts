import { STRATEGY_NAME, STRATEGY_TAGLINE } from "./brand";
import { FONT, MONO, T, esc, hudBackdrop, svgToPng } from "./terminalTheme";
import { alertTimeframeSuffix, strengthLabel, type AlertView } from "./tvAlertCopy";
import { signalTradeChartLabels, signalTradeChartNote, signalTradeChartSvg, TRADE_CHART_EXTRA_HEIGHT } from "./signalTradeChart";

const WIDTH = 840;

const ACCENT: Record<AlertView["tone"], string> = {
  buy: T.buy,
  take: T.take,
  stop: T.stop,
  sell: T.sell,
};

function money(v: number): string {
  return `$${v.toFixed(2)}`;
}

function signed(v: number): string {
  return `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;
}

type Field = { label: string; value: string; sub?: string; color: string };

function fieldsOf(view: AlertView, accent: string): Field[] {
  const fields: Field[] = [{ label: "信号价", value: money(view.price), color: T.text }];
  if (view.stop != null) {
    fields.push({
      label: "参考止损",
      value: money(view.stop),
      sub:
        view.stopPct != null
          ? `${signed(view.stopPct)}${view.stopMult != null ? ` · ${view.stopMult}×ATR` : ""}`
          : undefined,
      color: T.dim,
    });
  } else if (view.entry != null) {
    fields.push({ label: "开仓价", value: money(view.entry), color: T.text });
  }
  if (view.rps != null) {
    fields.push({ label: "强度", value: strengthLabel(view.rps), color: accent });
  } else if (view.pnl != null) {
    fields.push({ label: "盈亏", value: signed(view.pnl), color: view.pnl >= 0 ? T.buy : T.stop });
  }
  return fields;
}

function fieldCol(x: number, y: number, w: number, field: Field): string {
  return `
  <text x="${x}" y="${y}" font-size="14" fill="${T.dim}" font-family="${FONT}">${esc(field.label)}</text>
  <text x="${x}" y="${y + 28}" font-size="20" font-weight="bold" fill="${field.color}" font-family="${MONO}">${esc(field.value)}</text>
  ${field.sub ? `<text x="${x}" y="${y + 50}" font-size="13" fill="${T.muted}" font-family="${MONO}">${esc(field.sub)}</text>` : ""}
`;
}

export function signalCardSvg(view: AlertView): string {
  const accent = ACCENT[view.tone];
  const fields = fieldsOf(view, accent);
  const hasBar = view.rps != null;
  const hasFooter = Boolean(view.footer);
  const hasSub = fields.some((f) => f.sub);
  const baseHeight = 168 + (hasSub ? 18 : 0) + (hasBar ? 26 : 0) + (hasFooter ? 22 : 0);
  const height = baseHeight + (view.chart ? TRADE_CHART_EXTRA_HEIGHT : 0);

  const colW = (WIDTH - 56) / Math.max(fields.length, 1);
  const fieldY = 108;
  const cols = fields.map((field, i) => fieldCol(28 + i * colW, fieldY, colW, field)).join("\n");

  const barY = fieldY + (hasSub ? 68 : 50);
  const trackW = WIDTH - 136;
  const fillW = view.rps != null ? Math.round((trackW * Math.max(0, Math.min(100, view.rps))) / 100) : 0;
  const bar = hasBar
    ? `
  <text x="28" y="${barY}" font-size="13" fill="${T.dim}" font-family="${FONT}">相对大池</text>
  <rect x="108" y="${barY - 10}" width="${trackW}" height="7" rx="3" fill="${T.panelAlt}"/>
  <rect x="108" y="${barY - 10}" width="${fillW}" height="7" rx="3" fill="${accent}"/>
`
    : "";

  const footer = hasFooter
    ? `<text x="28" y="${baseHeight - 16}" font-size="13" fill="${T.dim}" font-family="${FONT}">${esc(view.footer ?? "")}</text>`
    : "";

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${WIDTH}" height="${height}" viewBox="0 0 ${WIDTH} ${height}" xmlns="http://www.w3.org/2000/svg">
  ${hudBackdrop(WIDTH, height, accent)}
  <text x="28" y="50" font-size="34" font-weight="bold" letter-spacing="1" fill="${T.text}" font-family="${MONO}">${esc(view.symbol)}</text>
  <text x="${WIDTH - 28}" y="32" font-size="11" fill="${T.cyan}" text-anchor="end" font-family="${MONO}">${esc(STRATEGY_NAME)}</text>
  <text x="${WIDTH - 28}" y="49" font-size="11" fill="${T.dim}" text-anchor="end" font-family="${FONT}">${esc(`${STRATEGY_TAGLINE}${alertTimeframeSuffix(view.tfLabel)}`)}</text>
  <rect x="28" y="66" width="56" height="22" rx="2" fill="${accent}"/>
  <text x="56" y="82" font-size="12" font-weight="bold" fill="${T.bg}" text-anchor="middle" font-family="${MONO}">${esc(view.code)}</text>
  <text x="94" y="82" font-size="16" fill="${T.text}" font-family="${FONT}">${esc(view.title)}</text>
  <line x1="28" y1="96" x2="${WIDTH - 28}" y2="96" stroke="${T.line}" stroke-width="1"/>
  ${cols}
  ${bar}
  ${footer}
  ${view.chart ? `<g transform="translate(28,${baseHeight + 4})">
    ${signalTradeChartSvg(view.chart)}
    ${signalTradeChartLabels(view.chart).map((label) => `<text x="${label.x + (label.align === "center" ? label.width / 2 : 0)}" y="${label.y + (label.height ?? 18) / 2 + (label.fontSize ?? 12) * .35}" text-anchor="${label.align === "center" ? "middle" : "start"}" font-size="${label.fontSize ?? 12}" font-weight="${label.fontWeight ?? 400}" fill="${label.color}" font-family="${FONT}">${esc(label.text)}</text>`).join("")}
    <text x="0" y="442" font-size="12" fill="${T.dim}" font-family="${FONT}">${esc(signalTradeChartNote(view.chart))}</text>
  </g>` : ""}
</svg>`;
}

export function renderSignalPng(view: AlertView): Promise<Buffer> {
  return svgToPng(signalCardSvg(view), WIDTH);
}
