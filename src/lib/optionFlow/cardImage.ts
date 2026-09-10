import { FONT, MONO, T, esc, hudBackdrop, hudHeader, metricTile, svgToPng } from "@/lib/discord/terminalTheme";

import type { OptionFlowLeg, OptionFlowPost } from "./types";

const WIDTH = 840;

export function formatPremium(n?: number): string {
  if (n == null || !Number.isFinite(n)) return "—";
  if (n >= 1e9) return `$${trimNum(n / 1e9)}B`;
  if (n >= 1e6) return `$${trimNum(n / 1e6)}M`;
  if (n >= 1e3) return `$${trimNum(n / 1e3)}K`;
  return `$${Math.round(n)}`;
}

function trimNum(n: number): string {
  const digits = n >= 100 ? 0 : 1;
  return n.toFixed(digits).replace(/\.0$/, "");
}

export function formatExpiry(raw?: string): string {
  if (!raw) return "—";
  if (raw === "next-year") return "次年";
  if (raw === "0DTE") return "0DTE";
  if (raw === "LEAPS") return "LEAPS";
  if (/^\d{2}$/.test(raw)) return `${Number(raw)}月`;
  return raw;
}

function formatTime(iso: string): string {
  return iso.replace("T", " ").slice(5, 16);
}

function rightLabel(right?: string): string {
  if (right === "put") return "PUT";
  if (right === "call") return "CALL";
  return "—";
}

function rightColor(right?: string): string {
  if (right === "put") return T.stop;
  if (right === "call") return T.buy;
  return T.cyan;
}

export function singleFlowSvg(post: OptionFlowPost): string {
  const leg = post.legs[0];
  const accent = rightColor(leg?.right);
  const height = 320;
  const y = 88;
  const gap = 12;
  const tileH = 84;
  const inner = WIDTH - 64;
  const tiles = [
    { label: "标的", value: leg?.ticker ?? "—", color: T.text },
    { label: "类型", value: rightLabel(leg?.right), color: accent },
    { label: "资金", value: formatPremium(leg?.premiumUsd), color: accent },
    { label: "行权", value: leg?.strike != null ? String(leg.strike) : "—", color: T.text },
    { label: "到期", value: formatExpiry(leg?.expiry), color: T.dim },
    ...(leg?.otmPct != null ? [{ label: "OTM", value: `${leg.otmPct}%`, color: T.dim }] : []),
  ];
  const tileW = (inner - gap * (tiles.length - 1)) / tiles.length;
  const boxes = tiles
    .map((tile, i) => metricTile(32 + i * (tileW + gap), y, tileW, tileH, tile.label, tile.value, undefined, tile.color))
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${WIDTH}" height="${height}" viewBox="0 0 ${WIDTH} ${height}" xmlns="http://www.w3.org/2000/svg">
  ${hudBackdrop(WIDTH, height, accent)}
  ${hudHeader(WIDTH, "FLOW", "期权流 · 单笔", formatTime(post.postedAt), accent)}
  ${boxes}
  <text x="32" y="220" font-size="15" fill="${T.dim}" font-family="${FONT}">${esc(leg?.note === "seller" ? "大额卖出" : leg?.right === "put" ? "大额 Put 成交" : "大额 Call 成交")}</text>
  <text x="32" y="284" font-size="12" fill="${T.muted}" font-family="${FONT}">噪音标签 · 不是买点 · 不标注来源</text>
</svg>`;
}

export function noteworthySvg(post: OptionFlowPost): string {
  const rows = post.legs;
  const rowH = 44;
  const headerH = 108;
  const height = headerH + Math.max(rows.length, 1) * rowH + 56;
  const col = { ticker: 56, right: 200, strike: 340, expiry: 500, premium: 800 };
  const body =
    rows.length === 0
      ? `<text x="${WIDTH / 2}" y="${headerH + 28}" font-size="16" fill="${T.muted}" text-anchor="middle" font-family="${FONT}">无名单</text>`
      : rows
          .map((leg, i) => noteworthyRow(leg, i, headerH + i * rowH, col, rowH))
          .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${WIDTH}" height="${height}" viewBox="0 0 ${WIDTH} ${height}" xmlns="http://www.w3.org/2000/svg">
  ${hudBackdrop(WIDTH, height, T.cyan)}
  ${hudHeader(WIDTH, "FLOW", "期权流 · 确认名单", formatTime(post.postedAt), T.cyan)}
  <text x="${col.ticker}" y="88" font-size="12" fill="${T.muted}" font-family="${FONT}">标的</text>
  <text x="${col.right}" y="88" font-size="12" fill="${T.muted}" text-anchor="end" font-family="${FONT}">类型</text>
  <text x="${col.strike}" y="88" font-size="12" fill="${T.muted}" text-anchor="end" font-family="${FONT}">行权</text>
  <text x="${col.expiry}" y="88" font-size="12" fill="${T.muted}" text-anchor="end" font-family="${FONT}">到期</text>
  <text x="${col.premium}" y="88" font-size="12" fill="${T.muted}" text-anchor="end" font-family="${FONT}">资金</text>
  <line x1="32" y1="100" x2="${WIDTH - 32}" y2="100" stroke="${T.line}" stroke-width="1"/>
  ${body}
  <text x="32" y="${height - 24}" font-size="12" fill="${T.muted}" font-family="${FONT}">OI Confirmed · 噪音标签 · 不是买点</text>
</svg>`;
}

function noteworthyRow(
  leg: OptionFlowLeg,
  index: number,
  y: number,
  col: { ticker: number; right: number; strike: number; expiry: number; premium: number },
  rowH: number,
): string {
  const bg = index % 2 === 0 ? T.bg : T.panel;
  const accent = rightColor(leg.right);
  return `
  <rect x="20" y="${y}" width="${WIDTH - 40}" height="${rowH}" fill="${bg}"/>
  <text x="${col.ticker}" y="${y + 29}" font-size="16" font-weight="bold" fill="${T.text}" font-family="${MONO}">${esc(leg.ticker)}</text>
  <text x="${col.right}" y="${y + 29}" font-size="15" fill="${accent}" text-anchor="end" font-family="${MONO}">${rightLabel(leg.right)}</text>
  <text x="${col.strike}" y="${y + 29}" font-size="15" fill="${T.dim}" text-anchor="end" font-family="${MONO}">${leg.strike ?? "—"}</text>
  <text x="${col.expiry}" y="${y + 29}" font-size="15" fill="${T.dim}" text-anchor="end" font-family="${MONO}">${esc(formatExpiry(leg.expiry))}</text>
  <text x="${col.premium}" y="${y + 29}" font-size="16" font-weight="bold" fill="${accent}" text-anchor="end" font-family="${MONO}">${formatPremium(leg.premiumUsd)}</text>
  <line x1="32" y1="${y + rowH}" x2="${WIDTH - 32}" y2="${y + rowH}" stroke="${T.line}" stroke-width="1"/>
`;
}

export function sessionDigestSvg(title: string, asOf: string, legs: OptionFlowLeg[]): string {
  const rowH = 44;
  const headerH = 108;
  const height = headerH + Math.max(legs.length, 1) * rowH + 56;
  const col = { ticker: 56, right: 200, strike: 360, expiry: 540, premium: 800 };
  const body = legs
    .map((leg, i) => {
      const y = headerH + i * rowH;
      const bg = i % 2 === 0 ? T.bg : T.panel;
      const accent = rightColor(leg.right);
      return `
  <rect x="20" y="${y}" width="${WIDTH - 40}" height="${rowH}" fill="${bg}"/>
  <text x="${col.ticker}" y="${y + 29}" font-size="16" font-weight="bold" fill="${T.text}" font-family="${MONO}">${esc(leg.ticker)}</text>
  <text x="${col.right}" y="${y + 29}" font-size="15" fill="${accent}" text-anchor="end" font-family="${MONO}">${rightLabel(leg.right)}</text>
  <text x="${col.strike}" y="${y + 29}" font-size="15" fill="${T.dim}" text-anchor="end" font-family="${MONO}">${leg.strike ?? "—"}</text>
  <text x="${col.expiry}" y="${y + 29}" font-size="15" fill="${T.dim}" text-anchor="end" font-family="${MONO}">${esc(formatExpiry(leg.expiry))}</text>
  <text x="${col.premium}" y="${y + 29}" font-size="16" font-weight="bold" fill="${accent}" text-anchor="end" font-family="${MONO}">${formatPremium(leg.premiumUsd)}</text>
  <line x1="32" y1="${y + rowH}" x2="${WIDTH - 32}" y2="${y + rowH}" stroke="${T.line}" stroke-width="1"/>`;
    })
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${WIDTH}" height="${height}" viewBox="0 0 ${WIDTH} ${height}" xmlns="http://www.w3.org/2000/svg">
  ${hudBackdrop(WIDTH, height, T.cyan)}
  ${hudHeader(WIDTH, "FLOW", title, asOf, T.cyan)}
  <text x="${col.ticker}" y="88" font-size="12" fill="${T.muted}" font-family="${FONT}">标的</text>
  <text x="${col.right}" y="88" font-size="12" fill="${T.muted}" text-anchor="end" font-family="${FONT}">类型</text>
  <text x="${col.strike}" y="88" font-size="12" fill="${T.muted}" text-anchor="end" font-family="${FONT}">行权</text>
  <text x="${col.expiry}" y="88" font-size="12" fill="${T.muted}" text-anchor="end" font-family="${FONT}">到期</text>
  <text x="${col.premium}" y="88" font-size="12" fill="${T.muted}" text-anchor="end" font-family="${FONT}">资金</text>
  <line x1="32" y1="100" x2="${WIDTH - 32}" y2="100" stroke="${T.line}" stroke-width="1"/>
  ${body}
  <text x="32" y="${height - 24}" font-size="12" fill="${T.muted}" font-family="${FONT}">当日汇总 · 已去重 · 噪音标签 · 不是买点</text>
</svg>`;
}

export function renderSingleFlowPng(post: OptionFlowPost): Promise<Buffer> {
  return svgToPng(singleFlowSvg(post), WIDTH);
}
export function renderNoteworthyPng(post: OptionFlowPost): Promise<Buffer> {
  return svgToPng(noteworthySvg(post), WIDTH);
}
export function renderSessionDigestPng(title: string, asOf: string, legs: OptionFlowLeg[]): Promise<Buffer> {
  return svgToPng(sessionDigestSvg(title, asOf, legs), WIDTH);
}
