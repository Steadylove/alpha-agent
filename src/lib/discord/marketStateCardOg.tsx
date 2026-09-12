import { ImageResponse } from "next/og";

import { STRATEGY_NAME, STRATEGY_TAGLINE, STRATEGY_TITLE } from "./brand";
import type { MarketStateView } from "./marketStateCopy";
import { loadOgFonts, OG_FONT } from "./ogFont";
import { CARD_DISCLAIMER, CARD_DISCLAIMER_HEIGHT, withDisclaimer } from "./cardDisclaimer";
import { CardWithDisclaimer } from "./cardDisclaimerOg";

const px = (n: number) => n;
const WIDTH = px(960);
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

function toneColor(tone: "pos" | "neg" | "flat"): string {
  if (tone === "pos") return T.buy;
  if (tone === "neg") return T.stop;
  return T.gold;
}

function stateText(input: MarketStateView): string {
  return [
    `${STRATEGY_TITLE} 关键位 资金结构 近月 正 Gamma Flip 磁铁 墙 截面描述 不是操作计划`,
    input.title,
    input.headline,
    input.asOf,
    input.dte,
    input.spot,
    input.netGex,
    input.flip,
    input.status,
    input.close,
    ...input.levels.flatMap((row) => [row.level, row.role, row.meaning]),
    ...input.peers.flatMap((row) => [row.symbol, row.line]),
  ].join(" ");
}

function Kpi({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", marginRight: px(28) }}>
      <div style={{ display: "flex", color: T.muted, fontSize: px(10) }}>{label}</div>
      <div style={{ display: "flex", color: color ?? T.text, fontSize: px(18), fontWeight: 700, marginTop: px(4) }}>
        {value}
      </div>
    </div>
  );
}

function MarketStateCard({ input }: { input: MarketStateView }) {
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
            {withDisclaimer(`近月 ${input.dte}  ·  ${input.asOf} 快照`)}
          </div>
        </div>

        <div style={{ display: "flex", color: T.text, fontSize: px(22), fontWeight: 700, marginTop: px(16) }}>
          {input.title}
        </div>
        <div style={{ display: "flex", color: T.dim, fontSize: px(15), marginTop: px(8) }}>{input.headline}</div>

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
          <Kpi label="现价" value={input.spot} />
          <Kpi label="近月净 GEX" value={input.netGex} color={toneColor(input.netGexTone)} />
          <Kpi label="Gamma Flip" value={input.flip} color={T.cyan} />
          <Kpi label="结构" value={input.status} color={toneColor(input.netGexTone)} />
        </div>

        <div style={{ display: "flex", color: T.muted, fontSize: px(12), marginTop: px(18) }}>关键位</div>
        <div style={{ display: "flex", width: "100%", height: px(1), background: T.line, marginTop: px(6), marginBottom: px(4) }} />

        <div style={{ display: "flex", flexDirection: "column", width: "100%" }}>
          {input.levels.map((row, i) => (
            <div
              key={`${row.role}-${i}`}
              style={{
                display: "flex",
                width: "100%",
                alignItems: "center",
                height: px(48),
                background: i % 2 === 0 ? "transparent" : T.panel,
                paddingLeft: px(4),
                paddingRight: px(4),
              }}
            >
              <div style={{ display: "flex", width: px(88), color: T.cyan, fontSize: px(16), fontWeight: 700 }}>
                {row.level}
              </div>
              <div style={{ display: "flex", width: px(140), color: T.text, fontSize: px(14), fontWeight: 700 }}>
                {row.role}
              </div>
              <div style={{ display: "flex", flexGrow: 1, color: T.muted, fontSize: px(13) }}>{row.meaning}</div>
            </div>
          ))}
        </div>

        {input.peers.length > 0 ? (
          <div style={{ display: "flex", flexDirection: "column", width: "100%", marginTop: px(14) }}>
            <div style={{ display: "flex", color: T.muted, fontSize: px(12), marginBottom: px(6) }}>同一截面</div>
            {input.peers.map((row) => (
              <div key={row.symbol} style={{ display: "flex", width: "100%", alignItems: "center", height: px(28) }}>
                <div
                  style={{
                    display: "flex",
                    width: px(56),
                    color: toneColor(row.tone),
                    fontSize: px(14),
                    fontWeight: 700,
                  }}
                >
                  {row.symbol}
                </div>
                <div style={{ display: "flex", color: T.dim, fontSize: px(13) }}>{row.line}</div>
              </div>
            ))}
          </div>
        ) : null}

        <div style={{ display: "flex", width: "100%", marginTop: px(16) }}>
          <div style={{ display: "flex", color: T.dim, fontSize: px(13) }}>{input.close}</div>
        </div>
      </div>
    </div>
  );
}

export async function renderMarketStateOgPng(input: MarketStateView): Promise<Buffer> {
  const height = px(214) + px(90) + input.levels.length * px(48) + input.peers.length * px(28) + px(120);
  const image = new ImageResponse(<CardWithDisclaimer width={WIDTH} contentHeight={height} background={T.bg} color={T.muted} border={T.line}>
    <MarketStateCard input={input} />
  </CardWithDisclaimer>, {
    width: WIDTH,
    height: height + CARD_DISCLAIMER_HEIGHT,
    fonts: await loadOgFonts(`${stateText(input)} ${CARD_DISCLAIMER}`),
  });
  return Buffer.from(await image.arrayBuffer());
}
