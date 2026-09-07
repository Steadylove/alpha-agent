import { ImageResponse } from "next/og";

import { bookPnlLabel, pnlLabel, winRateLabel, type CashBookView } from "./bookCopy";
import { loadOgFonts, OG_FONT } from "./ogFont";
import { strengthLabel } from "./tvAlertCopy";

const WIDTH = 960;
const ROW_H = 52;
const HEADER_H = 172;
const FOOTER_H = 92;
const T = {
  bg: "#070B12",
  panel: "#0E1522",
  line: "#1C2740",
  text: "#F1F5F9",
  muted: "#6B7A90",
  dim: "#9AA8BC",
  buy: "#3DDC97",
  stop: "#FF5C7A",
  cyan: "#5CE1E6",
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
    "ALPHA BOOK 现金账本 记账自 截至 代码 盈亏 开仓 仓位 强度 空仓 当前没有持仓 累计 回撤 均持 敞口 胜率 现金 持仓 只 强于 YTD",
    input.label,
    input.since,
    fmtAsOf(input.asOf),
    ...input.rows.flatMap((row) => [row.symbol, signed(row.floatPnlPct), row.entryPrice.toFixed(2), `${row.weightPct.toFixed(1)}%`, rowStrength(row.rps)]),
  ].join(" ");
}

function Chip({ label, value, color, last }: { label: string; value: string; color: string; last?: boolean }) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        marginRight: last ? 0 : 28,
      }}
    >
      <div style={{ display: "flex", color: T.muted, fontSize: 12, letterSpacing: 1 }}>{label}</div>
      <div style={{ display: "flex", color, fontSize: 22, fontWeight: 700, marginTop: 6 }}>{value}</div>
    </div>
  );
}

function Col({
  grow,
  children,
  color,
  end,
  bold,
  size,
}: {
  grow: number;
  children: string;
  color?: string;
  end?: boolean;
  bold?: boolean;
  size?: number;
}) {
  return (
    <div
      style={{
        display: "flex",
        flexGrow: grow,
        flexShrink: 1,
        flexBasis: 0,
        color: color ?? T.text,
        fontSize: size ?? 16,
        fontWeight: bold ? 700 : 400,
        justifyContent: end ? "flex-end" : "flex-start",
        alignItems: "center",
      }}
    >
      {children}
    </div>
  );
}

function BookCard({ input }: { input: CashBookView }) {
  const cashPct = Math.max(0, 100 - input.exposurePct);
  const exposure = input.avgExposure ?? input.exposurePct;
  const equityLabel = input.equity != null ? bookPnlLabel(input.equity) : "—";
  const equityColor = input.equity == null ? T.text : input.equity >= 1 ? T.buy : T.stop;
  const chips = [
    ...(input.dd != null ? [{ label: "回撤", value: `${input.dd.toFixed(0)}%`, color: T.stop }] : []),
    ...(input.mar != null ? [{ label: "MAR", value: input.mar.toFixed(2), color: T.text }] : []),
    ...(input.winRatePct !== undefined ? [{ label: "胜率", value: winRateLabel(input.winRatePct), color: T.text }] : []),
    ...(input.avgHoldings != null ? [{ label: "均持", value: input.avgHoldings.toFixed(1), color: T.text }] : []),
    ...(input.ytdPct != null
      ? [
          {
            label: input.ytdYear != null ? `${input.ytdYear} YTD` : "YTD",
            value: pnlLabel(input.ytdPct),
            color: input.ytdPct >= 0 ? T.buy : T.stop,
          },
        ]
      : []),
  ];

  return (
    <div
      style={{
        width: WIDTH,
        height: "100%",
        display: "flex",
        flexDirection: "column",
        background: T.bg,
        color: T.text,
        fontFamily: OG_FONT,
      }}
    >
      <div style={{ display: "flex", height: 4, background: T.cyan }} />
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          padding: "22px 32px 24px",
          flexGrow: 1,
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ display: "flex", alignItems: "center" }}>
            <div style={{ display: "flex", color: T.cyan, fontSize: 16, letterSpacing: 2, marginRight: 12, fontWeight: 700 }}>ALPHA</div>
            <div style={{ display: "flex", fontSize: 16, fontWeight: 700 }}>{`${input.label} 现金账本`}</div>
          </div>
          <div style={{ display: "flex", color: T.muted, fontSize: 13 }}>
            {`记账 ${input.since.slice(0, 10)}  →  ${fmtAsOf(input.asOf)}`}
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "flex-end", marginTop: 22, marginBottom: 8 }}>
          <div style={{ display: "flex", flexDirection: "column", marginRight: 40 }}>
            <div style={{ display: "flex", color: T.muted, fontSize: 12, letterSpacing: 2 }}>累计</div>
            <div style={{ display: "flex", color: equityColor, fontSize: 36, fontWeight: 700, lineHeight: 1, marginTop: 4 }}>
              {equityLabel}
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "flex-end", paddingBottom: 6 }}>
            {chips.map((chip, i) => (
              <Chip key={chip.label} {...chip} last={i === chips.length - 1} />
            ))}
          </div>
        </div>

        <div style={{ display: "flex", height: 1, background: T.line, marginTop: 10, marginBottom: 8 }} />
        <div style={{ display: "flex", color: T.muted, fontSize: 12, letterSpacing: 1, paddingLeft: 4, paddingRight: 4 }}>
          <Col grow={0.45} color={T.muted} size={12}>#</Col>
          <Col grow={1.2} color={T.muted} size={12}>代码</Col>
          <Col grow={1} color={T.muted} size={12} end>盈亏</Col>
          <Col grow={1} color={T.muted} size={12} end>开仓</Col>
          <Col grow={0.9} color={T.muted} size={12} end>仓位</Col>
          <Col grow={1.3} color={T.muted} size={12} end>强度</Col>
        </div>
        <div style={{ display: "flex", height: 1, background: T.line, marginTop: 8 }} />

        <div style={{ display: "flex", flexDirection: "column" }}>
          {input.rows.length === 0 ? (
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                justifyContent: "center",
                alignItems: "center",
                height: ROW_H + 12,
              }}
            >
              <div style={{ display: "flex", color: T.dim, fontSize: 18 }}>空仓</div>
              <div style={{ display: "flex", color: T.muted, fontSize: 13, marginTop: 6 }}>当前没有持仓</div>
            </div>
          ) : (
            input.rows.map((row, i) => (
              <div
                key={`${row.symbol}-${i}`}
                style={{
                  display: "flex",
                  alignItems: "center",
                  height: ROW_H,
                  background: i % 2 === 0 ? "transparent" : T.panel,
                  paddingLeft: 4,
                  paddingRight: 4,
                }}
              >
                <Col grow={0.45} color={T.muted} size={13}>{String(i + 1).padStart(2, "0")}</Col>
                <Col grow={1.2} bold>{row.symbol}</Col>
                <Col grow={1} end bold color={row.floatPnlPct >= 0 ? T.buy : T.stop}>{signed(row.floatPnlPct)}</Col>
                <Col grow={1} end color={T.dim}>{row.entryPrice.toFixed(2)}</Col>
                <Col grow={0.9} end color={T.dim}>{`${row.weightPct.toFixed(1)}%`}</Col>
                <Col grow={1.3} end color={T.cyan}>{rowStrength(row.rps)}</Col>
              </div>
            ))
          )}
        </div>

        <div style={{ display: "flex", flexDirection: "column", marginTop: 18 }}>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
            <div style={{ display: "flex", color: T.muted, fontSize: 12 }}>{`敞口 ${exposure.toFixed(0)}%`}</div>
            <div style={{ display: "flex", color: T.muted, fontSize: 12 }}>
              {`现金 ${cashPct.toFixed(0)}%   ·   当天敞口 ${input.exposurePct.toFixed(0)}%   ·   持仓 ${input.rows.length} 只`}
            </div>
          </div>
          <div style={{ display: "flex", height: 8, background: T.panel }}>
            <div
              style={{
                display: "flex",
                width: `${Math.max(0, Math.min(100, exposure))}%`,
                height: 8,
                background: T.cyan,
              }}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

const SCALE = 2;

export async function renderCashBookOgPng(input: CashBookView): Promise<Buffer> {
  const height = HEADER_H + Math.max(input.rows.length, 1) * ROW_H + FOOTER_H;
  const image = new ImageResponse(
    <div style={{ display: "flex", width: WIDTH * SCALE, height: height * SCALE }}>
      <div
        style={{
          display: "flex",
          width: WIDTH,
          height,
          transform: `scale(${SCALE})`,
          transformOrigin: "0 0",
        }}
      >
        <BookCard input={input} />
      </div>
    </div>,
    {
      width: WIDTH * SCALE,
      height: height * SCALE,
      fonts: await loadOgFonts(bookText(input)),
    },
  );
  return Buffer.from(await image.arrayBuffer());
}
