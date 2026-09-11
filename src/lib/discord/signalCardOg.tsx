import { ImageResponse } from "next/og";

import { STRATEGY_NAME, STRATEGY_TAGLINE } from "./brand";
import { loadOgFonts, OG_FONT } from "./ogFont";
import { alertCardFields, alertTimeframeSuffix, type AlertCardField, type AlertView } from "./tvAlertCopy";
import {
  signalTradeChartLabels, signalTradeChartNote, signalTradeChartSvg,
  TRADE_CHART_EXTRA_HEIGHT, TRADE_CHART_HEIGHT, TRADE_CHART_WIDTH,
  type SignalTradeChart,
} from "./signalTradeChart";

const WIDTH = 840;
const T = {
  bg: "#020617",
  panelAlt: "#111827",
  line: "#1E293B",
  text: "#F8FAFC",
  muted: "#64748B",
  dim: "#94A3B8",
  buy: "#22C55E",
  take: "#F59E0B",
  stop: "#F43F5E",
  sell: "#94A3B8",
  cyan: "#22D3EE",
};

const ACCENT: Record<AlertView["tone"], string> = {
  buy: T.buy,
  take: T.take,
  stop: T.stop,
  sell: T.sell,
};

type Field = AlertCardField & { color: string };

function fieldsOf(view: AlertView, accent: string): Field[] {
  return alertCardFields(view).map((field) => ({
    ...field,
    color:
      field.role === "stop"
        ? T.dim
        : field.role === "pnl"
          ? (view.pnl ?? 0) >= 0
            ? T.buy
            : T.stop
          : field.role === "strength"
            ? accent
            : T.text,
  }));
}

function SignalChart({ chart }: { chart: SignalTradeChart }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", marginTop: 18, flexShrink: 0 }}>
      <div style={{ display: "flex", position: "relative", width: TRADE_CHART_WIDTH, height: TRADE_CHART_HEIGHT }}>
        {/* SVG 只绘制几何图形，中文标签使用外层 OG 字体。 */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img alt="买卖点与 Vegas 通道" width={TRADE_CHART_WIDTH} height={TRADE_CHART_HEIGHT}
          src={`data:image/svg+xml;base64,${Buffer.from(signalTradeChartSvg(chart)).toString("base64")}`} />
        {signalTradeChartLabels(chart).map((label, i) => (
          <div key={i} style={{ display: "flex", position: "absolute", left: label.x, top: label.y, width: label.width,
            height: label.height ?? 18, fontSize: label.fontSize ?? 12, fontWeight: label.fontWeight ?? 400,
            alignItems: "center", justifyContent: label.align === "center" ? "center" : "flex-start", color: label.color }}>{label.text}</div>
        ))}
      </div>
      <div style={{ display: "flex", height: 22, alignItems: "center", fontSize: 12, color: T.dim }}>{signalTradeChartNote(chart)}</div>
    </div>
  );
}

function SignalCard({ view }: { view: AlertView }) {
  const accent = ACCENT[view.tone];
  const fields = fieldsOf(view, accent);
  const fill = view.rps != null ? Math.max(0, Math.min(100, view.rps)) : 0;

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
        borderLeftWidth: 4,
        borderLeftStyle: "solid",
        borderLeftColor: accent,
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", height: 44, flexShrink: 0 }}>
        <div style={{ display: "flex", fontSize: 34, fontWeight: 700, letterSpacing: 1 }}>{view.symbol}</div>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end" }}>
          <div style={{ display: "flex", color: T.cyan, fontSize: 11 }}>{STRATEGY_NAME}</div>
          <div style={{ display: "flex", color: T.dim, fontSize: 11, marginTop: 3 }}>{`${STRATEGY_TAGLINE}${alertTimeframeSuffix(view.tfLabel)}`}</div>
        </div>
      </div>
      <div style={{ display: "flex", alignItems: "center", marginTop: 14 }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: accent,
            color: T.bg,
            fontSize: 12,
            fontWeight: 700,
            height: 22,
            paddingLeft: 10,
            paddingRight: 10,
            marginRight: 12,
          }}
        >
          {view.code}
        </div>
        <div style={{ display: "flex", fontSize: 16 }}>{view.title}</div>
      </div>
      <div style={{ display: "flex", height: 1, background: T.line, marginTop: 12, marginBottom: 16 }} />
      <div style={{ display: "flex" }}>
        {fields.map((field, i) => (
          <div
            key={field.label}
            style={{
              display: "flex",
              flexDirection: "column",
              flexGrow: 1,
              flexShrink: 1,
              flexBasis: 0,
              marginRight: i === fields.length - 1 ? 0 : 16,
            }}
          >
            <div style={{ display: "flex", color: T.dim, fontSize: 14 }}>{field.label}</div>
            <div style={{ display: "flex", color: field.color, fontSize: 20, fontWeight: 700, marginTop: 8 }}>{field.value}</div>
            {field.sub ? (
              <div style={{ display: "flex", color: T.muted, fontSize: 13, marginTop: 6 }}>{field.sub}</div>
            ) : (
              <div style={{ display: "none" }} />
            )}
          </div>
        ))}
      </div>
      {view.rps != null ? (
        <div style={{ display: "flex", alignItems: "center", marginTop: 18 }}>
          <div style={{ display: "flex", color: T.dim, fontSize: 13, marginRight: 12 }}>相对大池</div>
          <div style={{ display: "flex", flexGrow: 1, height: 7, background: T.panelAlt }}>
            <div style={{ display: "flex", width: `${fill}%`, height: 7, background: accent }} />
          </div>
        </div>
      ) : (
        <div style={{ display: "none" }} />
      )}
      {view.footer ? (
        <div style={{ display: "flex", color: T.dim, fontSize: 13, marginTop: 16 }}>{view.footer}</div>
      ) : (
        <div style={{ display: "none" }} />
      )}
      {view.chart ? <SignalChart chart={view.chart} /> : null}
    </div>
  );
}

function signalText(view: AlertView): string {
  const fields = fieldsOf(view, ACCENT[view.tone]);
  return [
    `${STRATEGY_NAME} ${STRATEGY_TAGLINE} SIGNAL 买点 卖点 止盈 止损 信号价 参考止损 开仓价 强度 ATR 盈亏 相对大池 强于 触发 收盘跌破生效止损`,
    view.title,
    view.code,
    view.symbol,
    view.tfLabel,
    view.footer ?? "",
    ...(view.chart ? [...signalTradeChartLabels(view.chart).map((v) => v.text), signalTradeChartNote(view.chart)] : []),
    ...fields.flatMap((f) => [f.label, f.value, f.sub ?? ""]),
  ].join(" ");
}

export async function renderSignalOgPng(view: AlertView): Promise<Buffer> {
  const fields = fieldsOf(view, ACCENT[view.tone]);
  const hasSub = fields.some((f) => f.sub);
  // 买点还需容纳参考止损说明下方的强度条及底部留白，避免 OG 字体行高导致裁切。
  const height = 184 + (hasSub ? 18 : 0) + (view.rps != null ? 70 : 0) + (view.footer ? 22 : 0) + (view.chart ? TRADE_CHART_EXTRA_HEIGHT : 0);
  const image = new ImageResponse(<SignalCard view={view} />, {
    width: WIDTH,
    height,
    fonts: await loadOgFonts(signalText(view)),
  });
  return Buffer.from(await image.arrayBuffer());
}
