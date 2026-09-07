import type { LookbackView } from "@/lib/fund/lookbackLogic";

import { bookPnlLabel, pnlLabel, winRateLabel, type BookRowView } from "./bookCopy";
import { FONT, MONO, T, esc, hudBackdrop, hudHeader, metricTile, svgToPng } from "./terminalTheme";
import { strengthLabel } from "./tvAlertCopy";

const WIDTH = 840;
const ROW_H = 48;
const HEADER_H = 108;
const FOOTER_H = 196;

const COL = {
  rank: 52,
  symbol: 100,
  pnl: 300,
  entry: 460,
  weight: 620,
  strength: 800,
};

function signed(v: number): string {
  return `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`;
}

function fmtAsOf(s: string): string {
  return s.replace("T", " ").slice(0, 16);
}

export type CashBookCardInput = {
  asOf: string;
  since: string;
  label: string;
  rows: readonly BookRowView[];
  equity?: number;
  ytdPct?: number;
  ytdYear?: number;
  exposurePct: number;
  dd?: number;
  mar?: number;
  avgHoldings?: number;
  avgExposure?: number;
  winRatePct?: number | null;
};

function rowStrength(rps: number | null): string {
  return rps != null && rps >= 1 ? strengthLabel(rps) : "—";
}

function rowSvg(row: BookRowView, index: number, y: number): string {
  const bg = index % 2 === 0 ? T.bg : T.panel;
  const pnlColor = row.floatPnlPct >= 0 ? T.buy : T.stop;
  const rank = String(index + 1).padStart(2, "0");

  return `
  <rect x="20" y="${y}" width="${WIDTH - 40}" height="${ROW_H}" fill="${bg}" />
  <text x="${COL.rank}" y="${y + 31}" font-size="13" fill="${T.muted}" text-anchor="middle" font-family="${MONO}">${rank}</text>
  <text x="${COL.symbol}" y="${y + 32}" font-size="16" font-weight="bold" fill="${T.text}" font-family="${MONO}">${esc(row.symbol)}</text>
  <text x="${COL.pnl}" y="${y + 32}" font-size="16" font-weight="bold" fill="${pnlColor}" text-anchor="end" font-family="${MONO}">${signed(row.floatPnlPct)}</text>
  <text x="${COL.entry}" y="${y + 32}" font-size="15" fill="${T.dim}" text-anchor="end" font-family="${MONO}">${row.entryPrice.toFixed(2)}</text>
  <text x="${COL.weight}" y="${y + 32}" font-size="15" fill="${T.dim}" text-anchor="end" font-family="${MONO}">${row.weightPct.toFixed(1)}%</text>
  <text x="${COL.strength}" y="${y + 32}" font-size="15" fill="${T.cyan}" text-anchor="end" font-family="${MONO}">${esc(rowStrength(row.rps))}</text>
  <line x1="32" y1="${y + ROW_H}" x2="${WIDTH - 32}" y2="${y + ROW_H}" stroke="${T.line}" stroke-width="1" />
`;
}

export function cashBookSvg(input: CashBookCardInput): string {
  const bodyH = Math.max(input.rows.length, 1) * ROW_H;
  const height = HEADER_H + bodyH + FOOTER_H;
  const cashPct = Math.max(0, 100 - input.exposurePct);
  const since = input.since.slice(0, 10);
  const asOf = fmtAsOf(input.asOf);
  const subtitle = `记账自 ${since} · 截至 ${asOf}`;

  const body =
    input.rows.length === 0
      ? `<text x="${WIDTH / 2}" y="${HEADER_H + 32}" font-size="16" fill="${T.muted}" text-anchor="middle" font-family="${FONT}">空仓</text>`
      : input.rows.map((row, i) => rowSvg(row, i, HEADER_H + i * ROW_H)).join("\n");

  const footerY = HEADER_H + bodyH + 16;
  const tileH = 72;
  const gap = 12;
  const startX = 32;
  const inner = WIDTH - 64;
  const row = (
    tiles: readonly { label: string; value: string; color: string }[],
    y: number,
  ) => {
    const tileW = (inner - gap * (tiles.length - 1)) / tiles.length;
    return tiles
      .map((tile, i) =>
        metricTile(startX + i * (tileW + gap), y, tileW, tileH, tile.label, tile.value, undefined, tile.color),
      )
      .join("\n");
  };
  const stats = [
    ...(input.equity != null
      ? [
          {
            label: "累计",
            value: bookPnlLabel(input.equity),
            color: input.equity >= 1 ? T.buy : T.stop,
          },
        ]
      : []),
    ...(input.dd != null
      ? [{ label: "回撤", value: `${input.dd.toFixed(0)}%`, color: T.stop }]
      : []),
    ...(input.mar != null
      ? [{ label: "MAR", value: input.mar.toFixed(2), color: T.text }]
      : []),
    ...(input.avgHoldings != null
      ? [{ label: "均持", value: input.avgHoldings.toFixed(1), color: T.text }]
      : []),
    {
      label: "敞口",
      value: `${(input.avgExposure ?? input.exposurePct).toFixed(0)}%`,
      color: T.cyan,
    },
    ...(input.winRatePct !== undefined
      ? [{ label: "胜率", value: winRateLabel(input.winRatePct), color: T.text }]
      : []),
  ];
  const snapshot = [
    ...(input.ytdPct != null
      ? [
          {
            label: input.ytdYear != null ? `${input.ytdYear} YTD` : "YTD",
            value: pnlLabel(input.ytdPct),
            color: input.ytdPct >= 0 ? T.buy : T.stop,
          },
        ]
      : []),
    { label: "当天敞口", value: `${input.exposurePct.toFixed(0)}%`, color: T.cyan },
    { label: "现金", value: `${cashPct.toFixed(0)}%`, color: T.dim },
    { label: "持仓", value: `${input.rows.length} 只`, color: T.text },
  ];
  const boxes = `${row(stats, footerY)}\n${row(snapshot, footerY + tileH + 10)}`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${WIDTH}" height="${height}" viewBox="0 0 ${WIDTH} ${height}" xmlns="http://www.w3.org/2000/svg">
  ${hudBackdrop(WIDTH, height, T.cyan)}
  ${hudHeader(WIDTH, "ALPHA", `BOOK · ${input.label}`, subtitle, T.cyan)}
  <text x="${COL.rank}" y="88" font-size="12" fill="${T.muted}" text-anchor="middle" font-family="${FONT}">#</text>
  <text x="${COL.symbol}" y="88" font-size="12" fill="${T.muted}" font-family="${FONT}">代码</text>
  <text x="${COL.pnl}" y="88" font-size="12" fill="${T.muted}" text-anchor="end" font-family="${FONT}">盈亏</text>
  <text x="${COL.entry}" y="88" font-size="12" fill="${T.muted}" text-anchor="end" font-family="${FONT}">开仓价</text>
  <text x="${COL.weight}" y="88" font-size="12" fill="${T.muted}" text-anchor="end" font-family="${FONT}">仓位</text>
  <text x="${COL.strength}" y="88" font-size="12" fill="${T.muted}" text-anchor="end" font-family="${FONT}">强度</text>
  <line x1="32" y1="100" x2="${WIDTH - 32}" y2="100" stroke="${T.line}" stroke-width="1"/>
  ${body}
  ${boxes}
</svg>`;
}

export function cashBookFromLookback(view: LookbackView, label: string): CashBookCardInput {
  const s = view.stats;
  return {
    asOf: view.asOf,
    since: view.since,
    label,
    rows: view.rows,
    equity: view.equity,
    ytdPct: s.ytdPct ?? undefined,
    ytdYear: s.ytdYear ?? undefined,
    exposurePct: view.exposurePct,
    dd: s.dd,
    mar: s.mar,
    avgHoldings: s.avgHoldings,
    avgExposure: s.avgExposure,
    winRatePct: s.winRatePct,
  };
}

export function renderCashBookPng(input: CashBookCardInput): Promise<Buffer> {
  return svgToPng(cashBookSvg(input), WIDTH);
}
