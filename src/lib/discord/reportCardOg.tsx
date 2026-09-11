import { ImageResponse } from "next/og";
import { CARD_INK, CARD_SCALE as S } from "./cardTheme";
import { loadOgFonts, loadSignalNumberFont, OG_FONT, SIGNAL_NUMBER_FONT } from "./ogFont";
import type { ReportCardItem, ReportCardLayout } from "./reportCardLayout";

function DrawItem({ item, numberFont }: { item: ReportCardItem; numberFont: string }) {
  const position = { position: "absolute" as const, left: item.x * S, top: item.y * S, width: item.width * S, height: item.height * S };
  if (item.type === "rect") return <div style={{ display: "flex", ...position, background: item.fill,
    borderRadius: item.radius * S, ...(item.stroke ? { border: `${S}px solid ${item.stroke}` } : {}) }} />;
  if (item.type === "path") return <svg style={position} width={item.width * S} height={item.height * S} viewBox={`0 0 ${item.width} ${item.height}`}>
    <path d={item.d} fill="none" stroke={item.color} strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" />
  </svg>;
  return <div style={{ display: "flex", ...position, fontSize: item.size * S, fontWeight: item.weight,
    color: item.color, fontFamily: item.numeric ? numberFont : OG_FONT, whiteSpace: "pre", alignItems: "center",
    justifyContent: item.align === "right" ? "flex-end" : item.align === "center" ? "center" : "flex-start" }}>{item.text}</div>;
}

export async function renderReportCardOgPng(layout: ReportCardLayout): Promise<Buffer> {
  const text = layout.items.flatMap((item) => item.type === "text" ? [item.text] : []).join(" ");
  const [fonts, numberFont] = await Promise.all([loadOgFonts(text), loadSignalNumberFont(text).catch(() => null)]);
  const image = new ImageResponse(
    <div style={{ display: "flex", position: "relative", width: layout.width * S, height: layout.height * S,
      background: CARD_INK.bg, fontFamily: OG_FONT }}>
      {layout.items.map((item, i) => <DrawItem key={i} item={item} numberFont={numberFont ? SIGNAL_NUMBER_FONT : OG_FONT} />)}
    </div>,
    { width: layout.width * S, height: layout.height * S, fonts: numberFont ? [...fonts, numberFont] : fonts },
  );
  return Buffer.from(await image.arrayBuffer());
}
