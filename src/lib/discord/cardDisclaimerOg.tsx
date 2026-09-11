import type { ReactNode } from "react";
import { CARD_DISCLAIMER, CARD_DISCLAIMER_HEIGHT, CARD_DISCLAIMER_SIZE } from "./cardDisclaimer";
import { OG_FONT } from "./ogFont";

/** 为旧版 OG 卡片另留底部空间，不覆盖原内容。 */
export function CardWithDisclaimer({ children, width, contentHeight, background, color, border }: {
  children: ReactNode; width: number; contentHeight: number; background: string; color: string; border: string;
}) {
  return <div style={{ display: "flex", flexDirection: "column", width, height: contentHeight + CARD_DISCLAIMER_HEIGHT,
    background, fontFamily: OG_FONT }}>
    <div style={{ display: "flex", width, height: contentHeight, flexShrink: 0 }}>{children}</div>
    <div style={{ display: "flex", alignItems: "center", margin: "0 28px", height: CARD_DISCLAIMER_HEIGHT,
      flexShrink: 0, borderTop: `1px solid ${border}`, color, fontSize: CARD_DISCLAIMER_SIZE, whiteSpace: "pre" }}>
      {CARD_DISCLAIMER}
    </div>
  </div>;
}
