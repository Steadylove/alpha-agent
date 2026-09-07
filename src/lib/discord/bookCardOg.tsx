import { ImageResponse } from "next/og";

import { bookPnlLabel, pnlLabel, winRateLabel, type CashBookView } from "./bookCopy";
import { loadOgFonts, OG_FONT } from "./ogFont";
import { strengthLabel } from "./tvAlertCopy";

const WIDTH = 840;
const ROW_H = 48;
const HEADER_H = 108;
const FOOTER_H = 196;
const T = {
  bg: "#020617",
  panel: "#0B1220",
  line: "#1E293B",
  text: "#F8FAFC",
  muted: "#64748B",
  dim: "#94A3B8",
  buy: "#22C55E",
  stop: "#F43F5E",
  cyan: "#22D3EE",
};

function signed(v: number): string {
  return `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`;
}

function fmtAsOf(s: string): string {
  return s.replace("T", " ").slice(0, 16);
}

function rowStrength(rps: number | null): string {
  return rps != null && rps >= 1 ? strengthLabel(rps) : "—";
}

function bookText(input: CashBookView): string {
  return [
    "ALPHA BOOK 记账自 截至 代码 盈亏 开仓价 仓位 强度 空仓 累计 回撤 均持 敞口 胜率 当天敞口 现金 持仓 只 强于 YTD",
    input.label,
    input.since,
    fmtAsOf(input.asOf),
    ...input.rows.flatMap((row) => [row.symbol, signed(row.floatPnlPct), row.entryPrice.toFixed(2), `${row.weightPct.toFixed(1)}%`, rowStrength(row.rps)]),
  ].join(" ");
}

function BookCard({ input }: { input: CashBookView }) {
  const cashPct = Math.max(0, 100 - input.exposurePct);
  const subtitle = `记账自 ${input.since.slice(0, 10)} · 截至 ${fmtAsOf(input.asOf)}`;
  const stats = [
    ...(input.equity != null
      ? [{ label: "累计", value: bookPnlLabel(input.equity), color: input.equity >= 1 ? T.buy : T.stop }]
      : []),
    ...(input.dd != null ? [{ label: "回撤", value: `${input.dd.toFixed(0)}%`, color: T.stop }] : []),
    ...(input.mar != null ? [{ label: "MAR", value: input.mar.toFixed(2), color: T.text }] : []),
    ...(input.avgHoldings != null ? [{ label: "均持", value: input.avgHoldings.toFixed(1), color: T.text }] : []),
    { label: "敞口", value: `${(input.avgExposure ?? input.exposurePct).toFixed(0)}%`, color: T.cyan },
    ...(input.winRatePct !== undefined ? [{ label: "胜率", value: winRateLabel(input.winRatePct), color: T.text }] : []),
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

  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        background: T.bg,
        color: T.text,
        padding: "20px 28px",
        fontFamily: OG_FONT,
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div style={{ display: "flex", alignItems: "center" }}>
          <div style={{ color: T.cyan, fontSize: 13, marginRight: 16 }}>ALPHA</div>
          <div style={{ fontSize: 16, fontWeight: 700 }}>{`BOOK · ${input.label}`}</div>
        </div>
        <div style={{ color: T.muted, fontSize: 13 }}>{subtitle}</div>
      </div>
      <div style={{ height: 1, background: T.line, marginTop: 12, marginBottom: 8 }} />
      <div style={{ display: "flex", color: T.muted, fontSize: 12, marginBottom: 4 }}>
        <div style={{ width: 40 }}>#</div>
        <div style={{ width: 90 }}>代码</div>
        <div style={{ width: 90, justifyContent: "flex-end" }}>盈亏</div>
        <div style={{ width: 110, justifyContent: "flex-end" }}>开仓价</div>
        <div style={{ width: 90, justifyContent: "flex-end" }}>仓位</div>
        <div style={{ width: 140, justifyContent: "flex-end" }}>强度</div>
      </div>
      <div style={{ height: 1, background: T.line, marginBottom: 4 }} />
      {input.rows.length === 0 ? (
        <div style={{ display: "flex", justifyContent: "center", alignItems: "center", color: T.muted, fontSize: 16, height: ROW_H }}>
          空仓
        </div>
      ) : (
        input.rows.map((row, i) => (
          <div
            key={`${row.symbol}-${i}`}
            style={{
              display: "flex",
              alignItems: "center",
              height: ROW_H,
              background: i % 2 === 0 ? T.bg : T.panel,
              fontSize: 16,
            }}
          >
            <div style={{ width: 40, color: T.muted }}>{String(i + 1).padStart(2, "0")}</div>
            <div style={{ width: 90, fontWeight: 700 }}>{row.symbol}</div>
            <div style={{ width: 90, justifyContent: "flex-end", color: row.floatPnlPct >= 0 ? T.buy : T.stop, fontWeight: 700 }}>
              {signed(row.floatPnlPct)}
            </div>
            <div style={{ width: 110, justifyContent: "flex-end", color: T.dim }}>{row.entryPrice.toFixed(2)}</div>
            <div style={{ width: 90, justifyContent: "flex-end", color: T.dim }}>{row.weightPct.toFixed(1)}%</div>
            <div style={{ width: 140, justifyContent: "flex-end", color: T.cyan }}>{rowStrength(row.rps)}</div>
          </div>
        ))
      )}
      <div style={{ display: "flex", marginTop: 16 }}>
        {stats.map((tile, i) => (
          <div
            key={tile.label}
            style={{
              display: "flex",
              flexDirection: "column",
              flex: 1,
              background: T.panel,
              borderWidth: 1,
              borderStyle: "solid",
              borderColor: T.line,
              borderLeftWidth: 3,
              borderLeftColor: tile.color,
              padding: "10px 12px",
              marginRight: i === stats.length - 1 ? 0 : 12,
            }}
          >
            <div style={{ color: T.muted, fontSize: 11 }}>{tile.label}</div>
            <div style={{ color: tile.color, fontSize: 22, fontWeight: 700, marginTop: 8 }}>{tile.value}</div>
          </div>
        ))}
      </div>
      <div style={{ display: "flex", marginTop: 10 }}>
        {snapshot.map((tile, i) => (
          <div
            key={tile.label}
            style={{
              display: "flex",
              flexDirection: "column",
              flex: 1,
              background: T.panel,
              borderWidth: 1,
              borderStyle: "solid",
              borderColor: T.line,
              borderLeftWidth: 3,
              borderLeftColor: tile.color,
              padding: "10px 12px",
              marginRight: i === snapshot.length - 1 ? 0 : 12,
            }}
          >
            <div style={{ color: T.muted, fontSize: 11 }}>{tile.label}</div>
            <div style={{ color: tile.color, fontSize: 22, fontWeight: 700, marginTop: 8 }}>{tile.value}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

export async function renderCashBookOgPng(input: CashBookView): Promise<Buffer> {
  const height = HEADER_H + Math.max(input.rows.length, 1) * ROW_H + FOOTER_H;
  const image = new ImageResponse(<BookCard input={input} />, {
    width: WIDTH,
    height,
    fonts: await loadOgFonts(bookText(input)),
  });
  return Buffer.from(await image.arrayBuffer());
}
