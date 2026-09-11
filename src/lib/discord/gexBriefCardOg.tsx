import { ImageResponse } from "next/og";

import { STRATEGY_NAME, STRATEGY_TAGLINE, STRATEGY_TITLE } from "./brand";
import type { GexCardView, GexRowView } from "./gexCopy";
import type { GexBriefView, MarketStateView } from "./marketStateCopy";
import { loadOgFonts, OG_FONT } from "./ogFont";
import { CARD_DISCLAIMER, CARD_DISCLAIMER_HEIGHT } from "./cardDisclaimer";
import { CardWithDisclaimer } from "./cardDisclaimerOg";

const px = (n: number) => n;
const WIDTH = px(960);
const ROW_H = px(68);
const LEVEL_H = px(48);
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
};

function statusColor(status: string): string {
  if (status.includes("负")) return T.stop;
  if (status.includes("正")) return T.buy;
  return "#E4B86A";
}

function toneColor(tone: "pos" | "neg" | "flat"): string {
  if (tone === "pos") return T.buy;
  if (tone === "neg") return T.stop;
  return "#E4B86A";
}

function briefText(input: GexBriefView): string {
  return [
    `${STRATEGY_TITLE} GEX Gamma Flip Call Wall Put Wall 净GEX 现价 近月 偏正 偏负 临界 关键位 资金结构`,
    "10Y 口径 墙 GEX(S) Flip 现价 ±3% 快照 截面描述 不是操作计划",
    input.gex.asOf,
    input.gex.dte,
    input.gex.tnx ?? "",
    input.state.title,
    input.state.headline,
    input.state.close,
    ...input.gex.rows.flatMap((row) => [
      row.symbol,
      row.spot,
      row.status,
      row.netGex,
      row.flip,
      row.callWall,
      row.putWall,
      row.impact,
    ]),
    ...input.state.levels.flatMap((row) => [row.level, row.role, row.meaning]),
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
        width: `${(grow / 6.4) * 100}%`,
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

function Kpi({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", marginRight: px(28) }}>
      <div style={{ display: "flex", color: T.muted, fontSize: px(10) }}>{label}</div>
      <div style={{ display: "flex", color: color ?? T.text, fontSize: px(16), fontWeight: 700, marginTop: px(4) }}>
        {value}
      </div>
    </div>
  );
}

function Table({ rows }: { rows: GexRowView[] }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", width: "100%" }}>
      <div style={{ display: "flex", width: "100%", height: px(1), background: T.line, marginTop: px(16), marginBottom: px(8) }} />
      <div style={{ display: "flex", width: "100%", color: T.muted, fontSize: px(12), paddingLeft: px(4), paddingRight: px(4) }}>
        <Col grow={0.85} color={T.muted} size={12}>标的</Col>
        <Col grow={0.7} color={T.muted} size={12}>状态</Col>
        <Col grow={0.95} color={T.muted} size={12} end>现价</Col>
        <Col grow={1.1} color={T.muted} size={12} end>净GEX</Col>
        <Col grow={0.95} color={T.muted} size={12} end>Flip</Col>
        <Col grow={0.9} color={T.muted} size={12} end>Call</Col>
        <Col grow={0.95} color={T.muted} size={12} end>Put</Col>
      </div>
      <div style={{ display: "flex", width: "100%", height: px(1), background: T.line, marginTop: px(8) }} />
      {rows.map((row, i) => (
        <div
          key={row.symbol}
          style={{
            display: "flex",
            flexDirection: "column",
            width: "100%",
            height: ROW_H,
            background: i % 2 === 0 ? "transparent" : T.panel,
            paddingLeft: px(4),
            paddingRight: px(4),
            justifyContent: "center",
          }}
        >
          <div style={{ display: "flex", width: "100%", alignItems: "center" }}>
            <Col grow={0.85} bold>{row.symbol}</Col>
            <Col grow={0.7} color={statusColor(row.status)} size={14} bold>{row.status}</Col>
            <Col grow={0.95} end color={T.dim}>{row.spot}</Col>
            <Col grow={1.1} end bold color={toneColor(row.netGexTone)}>{row.netGex}</Col>
            <Col grow={0.95} end color={T.cyan}>{row.flip}</Col>
            <Col grow={0.9} end color={T.buy}>{row.callWall}</Col>
            <Col grow={0.95} end color={T.stop}>{row.putWall}</Col>
          </div>
          <div style={{ display: "flex", color: T.muted, fontSize: px(12), marginTop: px(4) }}>{row.impact}</div>
        </div>
      ))}
    </div>
  );
}

function Structure({ state }: { state: MarketStateView }) {
  const closeLines = state.close.split(/(?<=。)/).map((line) => line.trim()).filter(Boolean);
  return (
    <div style={{ display: "flex", flexDirection: "column", width: "100%", marginTop: px(18) }}>
      <div style={{ display: "flex", color: T.text, fontSize: px(18), fontWeight: 700 }}>{state.title}</div>
      <div style={{ display: "flex", color: T.dim, fontSize: px(14), marginTop: px(6) }}>{state.headline}</div>
      <div style={{ display: "flex", color: T.muted, fontSize: px(12), marginTop: px(16) }}>关键位</div>
      <div style={{ display: "flex", width: "100%", height: px(1), background: T.line, marginTop: px(6), marginBottom: px(4) }} />
      {state.levels.map((row, i) => (
        <div
          key={`${row.role}-${i}`}
          style={{
            display: "flex",
            width: "100%",
            alignItems: "center",
            height: LEVEL_H,
            background: i % 2 === 0 ? "transparent" : T.panel,
            paddingLeft: px(4),
            paddingRight: px(4),
          }}
        >
          <div style={{ display: "flex", width: px(88), color: T.cyan, fontSize: px(16), fontWeight: 700 }}>{row.level}</div>
          <div style={{ display: "flex", width: px(140), color: T.text, fontSize: px(14), fontWeight: 700 }}>{row.role}</div>
          <div style={{ display: "flex", flexGrow: 1, color: T.muted, fontSize: px(13) }}>{row.meaning}</div>
        </div>
      ))}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          width: "100%",
          marginTop: px(16),
          padding: `${px(12)}px ${px(14)}px`,
          background: T.box,
          border: `1px solid ${T.line}`,
        }}
      >
        {closeLines.map((line, i) => (
          <div
            key={line}
            style={{ display: "flex", color: T.dim, fontSize: px(13), marginTop: i === 0 ? 0 : px(6) }}
          >
            {line}
          </div>
        ))}
      </div>
    </div>
  );
}

function GexBriefCard({ input }: { input: GexBriefView }) {
  const gex = input.gex;
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
          padding: `${px(22)}px ${px(28)}px ${px(20)}px`,
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
            {`近月 ${gex.dte}  ·  ${gex.asOf} 快照`}
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
          <Kpi label="10Y" value={gex.tnx == null ? "—" : `${gex.tnx}%`} />
          <Kpi label="口径" value="GEX(S) Flip" />
          <Kpi label="墙" value="现价 ±3%" />
        </div>
        <Table rows={gex.rows} />
        <Structure state={input.state} />
      </div>
    </div>
  );
}

export function isGexBriefView(input: GexBriefView | GexCardView): input is GexBriefView {
  return "gex" in input && "state" in input;
}

export async function renderGexBriefOgPng(input: GexBriefView): Promise<Buffer> {
  const rows = Math.max(input.gex.rows.length, 1);
  const levels = Math.max(input.state.levels.length, 1);
  const closeLines = Math.max(input.state.close.split(/(?<=。)/).filter((line) => line.trim()).length, 1);
  const height = px(248) + rows * ROW_H + px(92) + levels * LEVEL_H + px(56) + closeLines * px(22);
  const image = new ImageResponse(<CardWithDisclaimer width={WIDTH} contentHeight={height} background={T.bg} color={T.muted} border={T.line}>
    <GexBriefCard input={input} />
  </CardWithDisclaimer>, {
    width: WIDTH,
    height: height + CARD_DISCLAIMER_HEIGHT,
    fonts: await loadOgFonts(`${briefText(input)} ${CARD_DISCLAIMER}`),
  });
  return Buffer.from(await image.arrayBuffer());
}
