import { ImageResponse } from "next/og";
import { loadOgFonts, loadSignalNumberFont, OG_FONT, SIGNAL_NUMBER_FONT } from "./ogFont";
import { signalCardLayout, SIGNAL_CARD_SCALE, SIGNAL_INK, type SignalCardItem } from "./signalCardLayout";
import { signalTradeChartSvg, TRADE_CHART_HEIGHT, TRADE_CHART_WIDTH } from "./signalTradeChart";
import type { AlertView } from "./tvAlertCopy";

function DrawItem({ item, numberFont }: { item: SignalCardItem; numberFont: string }) {
  const s = SIGNAL_CARD_SCALE;
  if (item.type === "chart") return (
    // SVG 源、文字和输出画布均使用 2× 像素，不放大已生成的低分辨率 PNG。
    // eslint-disable-next-line @next/next/no-img-element
    <img alt="信号与 Vegas 通道" width={TRADE_CHART_WIDTH * s} height={TRADE_CHART_HEIGHT * s}
      style={{ position: "absolute", left: item.x * s, top: item.y * s }}
      src={`data:image/svg+xml;base64,${Buffer.from(signalTradeChartSvg(item.chart, s)).toString("base64")}`} />
  );
  if (item.type === "rect") return <div style={{ display: "flex", position: "absolute", left: item.x * s, top: item.y * s,
    width: item.width * s, height: item.height * s, background: item.fill, borderRadius: (item.radius ?? 0) * s,
    ...(item.stroke ? { border: `${s}px solid ${item.stroke}` } : {}) }} />;
  return <div style={{ display: "flex", position: "absolute", left: item.x * s, top: item.y * s,
    width: item.width * s, height: item.height * s, fontSize: item.size * s, fontWeight: item.weight,
    color: item.color, fontFamily: item.numeric ? numberFont : OG_FONT, whiteSpace: "pre",
    alignItems: "center", justifyContent: item.align === "right" ? "flex-end" : item.align === "center" ? "center" : "flex-start" }}>{item.text}</div>;
}

export async function renderSignalOgPng(view: AlertView): Promise<Buffer> {
  const layout = signalCardLayout(view);
  const texts = layout.items.flatMap((item) => item.type === "text" ? [item.text] : []);
  const [fonts, numberFont] = await Promise.all([loadOgFonts(texts.join(" ")), loadSignalNumberFont(texts.join(" ")).catch(() => null)]);
  const s = SIGNAL_CARD_SCALE;
  const image = new ImageResponse(
    <div style={{ display: "flex", position: "relative", width: layout.width * s, height: layout.height * s, background: SIGNAL_INK.bg, fontFamily: OG_FONT }}>
      {layout.items.map((item, i) => <DrawItem key={i} item={item} numberFont={numberFont ? SIGNAL_NUMBER_FONT : OG_FONT} />)}
    </div>,
    { width: layout.width * s, height: layout.height * s, fonts: numberFont ? [...fonts, numberFont] : fonts },
  );
  return Buffer.from(await image.arrayBuffer());
}
