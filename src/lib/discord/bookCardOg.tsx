import { ImageResponse } from "next/og";

import { STRATEGY_NAME, STRATEGY_TAGLINE, STRATEGY_TITLE } from "./brand";
import { bookPnlLabel, daysOpenLabel, daysOpenOf, pnlLabel, winRateLabel, type CashBookView } from "./bookCopy";
import { loadOgFonts, OG_FONT } from "./ogFont";

const S = 1;
const px = (n: number) => n * S;
const WIDTH = px(960);
const ROW_H = px(44);
const HEADER_H = px(214);
const FOOTER_H = px(72);
const T = {
  bg: "#0B1015",
  panel: "#121820",
  box: "#10161D",
  line: "#243042",
  text: "#F4F7FB",
  muted: "#8B9BB0",
  dim: "#A8B4C4",
  buy: "#4ADE80",
  stop: "#F87171",
  cyan: "#7DD3FC",
  gold: "#E4B86A",
};

function signed(v: number): string {
  return `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`;
}

function fmtAsOf(s: string): string {
  return s.replace("T", " ").slice(0, 16);
}

function sparkPath(values: readonly number[], w: number, h: number): string {
  if (values.length < 2) return "";
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  return values
    .map((v, i) => {
      const x = (i / (values.length - 1)) * w;
      const y = h - ((v - min) / span) * (h - 2) - 1;
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(" ");
}

function bookText(input: CashBookView): string {
  return [
    `${STRATEGY_TITLE} 现金账本 更新 Cumulative P&L Year-to-Date Return Max Drawdown vs QQQ Win Rate 胜率 持仓天数 代码 仓位 开仓价格 盈亏比例 EXPOSURE 敞口 Cash 现金 空仓 当前没有持仓`,
    input.label,
    input.since,
    fmtAsOf(input.asOf),
    ...input.rows.flatMap((row) => [
      row.symbol,
      signed(row.floatPnlPct),
      `$${row.entryPrice.toFixed(2)}`,
      `${row.weightPct.toFixed(1)}%`,
      daysOpenLabel(daysOpenOf(row.entryDate, input.asOf)),
    ]),
  ].join(" ");
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
        width: `${(grow / 5.9) * 100}%`,
        flexGrow: 0,
        flexShrink: 0,
        color: color ?? T.text,
        fontSize: px(size ?? 15),
        fontWeight: bold ? 700 : 400,
        justifyContent: end ? "flex-end" : "flex-start",
        alignItems: "center",
      }}
    >
      {children}
    </div>
  );
}

function Kpi({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", marginLeft: px(14) }}>
      <div style={{ display: "flex", color: T.muted, fontSize: px(10) }}>{label}</div>
      <div style={{ display: "flex", color, fontSize: px(18), fontWeight: 700, marginTop: px(4) }}>{value}</div>
    </div>
  );
}

function BookCard({ input }: { input: CashBookView }) {
  const cashPct = Math.max(0, 100 - input.exposurePct);
  const equityLabel = input.equity != null ? bookPnlLabel(input.equity) : "—";
  const equityColor = input.equity == null ? T.text : input.equity >= 1 ? T.cyan : T.stop;
  const ytdLabel = input.ytdPct != null ? pnlLabel(input.ytdPct) : "—";
  const ytdColor = input.ytdPct == null ? T.text : input.ytdPct >= 0 ? T.buy : T.stop;
  const ddLabel = input.dd != null ? `${input.dd.toFixed(0)}%` : "—";
  const vsLabel = input.vsQqqPct == null ? "—" : pnlLabel(input.vsQqqPct);
  const vsColor = input.vsQqqPct == null ? T.text : input.vsQqqPct >= 0 ? T.buy : T.stop;
  const winLabel = input.winRatePct === undefined ? null : winRateLabel(input.winRatePct);
  const path = sparkPath(input.curve ?? [], 88, 36);

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
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          width: "100%",
          padding: `${px(22)}px ${px(28)}px ${px(18)}px`,
          flexGrow: 1,
        }}
      >
        <div style={{ display: "flex", width: "100%", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ display: "flex", alignItems: "center" }}>
            <div style={{ display: "flex", color: T.text, fontSize: px(18), fontWeight: 700 }}>{STRATEGY_NAME}</div>
            <div style={{ display: "flex", color: T.muted, fontSize: px(18), marginLeft: px(8), marginRight: px(8) }}>|</div>
            <div style={{ display: "flex", color: T.dim, fontSize: px(16) }}>{STRATEGY_TAGLINE}</div>
          </div>
          <div style={{ display: "flex", color: T.muted, fontSize: px(13) }}>
            {`${input.since.slice(0, 10)}  →  ${fmtAsOf(input.asOf)} 更新`}
          </div>
        </div>

        <div
          style={{
            display: "flex",
            width: "100%",
            alignItems: "center",
            marginTop: px(16),
            padding: `${px(12)}px ${px(16)}px`,
            background: T.box,
            border: `1px solid ${T.line}`,
          }}
        >
          <div style={{ display: "flex", width: px(96), height: px(40), alignItems: "center" }}>
            {path ? (
              <svg width={88} height={36} viewBox="0 0 88 36">
                <path d={path} stroke={T.cyan} strokeWidth="2" fill="none" />
              </svg>
            ) : (
              <div style={{ display: "flex", width: px(88), height: px(2), background: T.line }} />
            )}
          </div>
          <Kpi label="Cumulative P&L" value={equityLabel} color={equityColor} />
          <Kpi label="Year-to-Date Return" value={ytdLabel} color={ytdColor} />
          <Kpi label="Max Drawdown" value={ddLabel} color={T.stop} />
          <Kpi label="Win Rate" value={winLabel ?? "—"} color={T.text} />
          <Kpi label={`${STRATEGY_NAME} vs. QQQ`} value={vsLabel} color={vsColor} />
        </div>

        <div style={{ display: "flex", width: "100%", height: px(1), background: T.line, marginTop: px(16), marginBottom: px(8) }} />
        <div style={{ display: "flex", width: "100%", color: T.muted, fontSize: px(12), paddingLeft: px(4), paddingRight: px(4) }}>
          <Col grow={0.4} color={T.muted} size={12}>#</Col>
          <Col grow={1.0} color={T.muted} size={12}>代码</Col>
          <Col grow={1.1} color={T.muted} size={12}>持仓天数</Col>
          <Col grow={0.9} color={T.muted} size={12} end>仓位</Col>
          <Col grow={1.3} color={T.muted} size={12} end>开仓价格</Col>
          <Col grow={1.2} color={T.muted} size={12} end>盈亏比例</Col>
        </div>
        <div style={{ display: "flex", width: "100%", height: px(1), background: T.line, marginTop: px(8) }} />

        <div style={{ display: "flex", flexDirection: "column", width: "100%" }}>
          {input.rows.length === 0 ? (
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                justifyContent: "center",
                alignItems: "center",
                height: ROW_H + px(12),
              }}
            >
              <div style={{ display: "flex", color: T.dim, fontSize: px(18) }}>空仓</div>
              <div style={{ display: "flex", color: T.muted, fontSize: px(13), marginTop: px(6) }}>当前没有持仓</div>
            </div>
          ) : (
            input.rows.map((row, i) => (
              <div
                key={`${row.symbol}-${i}`}
                style={{
                  display: "flex",
                  width: "100%",
                  alignItems: "center",
                  height: ROW_H,
                  background: i % 2 === 0 ? "transparent" : T.panel,
                  paddingLeft: px(4),
                  paddingRight: px(4),
                }}
              >
                <Col grow={0.4} color={T.muted} size={13}>{String(i + 1)}</Col>
                <Col grow={1.0} bold>{row.symbol}</Col>
                <Col grow={1.1} color={T.dim} size={14}>{daysOpenLabel(daysOpenOf(row.entryDate, input.asOf))}</Col>
                <Col grow={0.9} end color={T.dim}>{`${row.weightPct.toFixed(1)}%`}</Col>
                <Col grow={1.3} end color={T.dim}>{`$${row.entryPrice.toFixed(2)}`}</Col>
                <Col grow={1.2} end bold color={row.floatPnlPct >= 0 ? T.buy : T.stop}>{signed(row.floatPnlPct)}</Col>
              </div>
            ))
          )}
        </div>

        <div style={{ display: "flex", width: "100%", justifyContent: "space-between", marginTop: px(18), alignItems: "center" }}>
          <div style={{ display: "flex", alignItems: "center" }}>
            <div style={{ display: "flex", color: T.cyan, fontSize: px(13), letterSpacing: 1 }}>EXPOSURE</div>
            <div style={{ display: "flex", color: T.muted, fontSize: px(13), marginLeft: px(6) }}>(敞口)</div>
            <div style={{ display: "flex", color: T.cyan, fontSize: px(16), fontWeight: 700, marginLeft: px(10) }}>
              {`${input.exposurePct.toFixed(0)}%`}
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center" }}>
            <div style={{ display: "flex", color: T.gold, fontSize: px(13), letterSpacing: 1 }}>Cash</div>
            <div style={{ display: "flex", color: T.muted, fontSize: px(13), marginLeft: px(6) }}>(现金)</div>
            <div style={{ display: "flex", color: T.gold, fontSize: px(16), fontWeight: 700, marginLeft: px(10) }}>
              {`${cashPct.toFixed(0)}%`}
            </div>
          </div>
        </div>
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
