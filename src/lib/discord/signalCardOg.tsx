import { ImageResponse } from "next/og";

import { STRATEGY_NAME, STRATEGY_TAGLINE } from "./brand";
import { loadOgFonts, OG_FONT } from "./ogFont";
import { strengthLabel, type AlertView } from "./tvAlertCopy";

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
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div style={{ display: "flex", alignItems: "center" }}>
          <div style={{ display: "flex", color: T.cyan, fontSize: 13, marginRight: 16 }}>{STRATEGY_NAME}</div>
          <div style={{ display: "flex", fontSize: 16, fontWeight: 700 }}>{`${STRATEGY_TAGLINE} · ${view.tfLabel}`}</div>
        </div>
        <div style={{ display: "flex", fontSize: 22, fontWeight: 700 }}>{view.symbol}</div>
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
    </div>
  );
}

function signalText(view: AlertView): string {
  const fields = fieldsOf(view, ACCENT[view.tone]);
  return [
    `${STRATEGY_NAME} ${STRATEGY_TAGLINE} SIGNAL 买点 卖点 止盈 止损 信号价 参考止损 开仓价 强度 盈亏 相对大池 强于 触发 收盘跌破生效止损`,
    view.title,
    view.code,
    view.symbol,
    view.tfLabel,
    view.footer ?? "",
    ...fields.flatMap((f) => [f.label, f.value, f.sub ?? ""]),
  ].join(" ");
}

export async function renderSignalOgPng(view: AlertView): Promise<Buffer> {
  const fields = fieldsOf(view, ACCENT[view.tone]);
  const hasSub = fields.some((f) => f.sub);
  const height = 168 + (hasSub ? 18 : 0) + (view.rps != null ? 26 : 0) + (view.footer ? 22 : 0);
  const image = new ImageResponse(<SignalCard view={view} />, {
    width: WIDTH,
    height,
    fonts: await loadOgFonts(signalText(view)),
  });
  return Buffer.from(await image.arrayBuffer());
}
