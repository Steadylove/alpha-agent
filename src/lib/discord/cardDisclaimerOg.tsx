import type { ReactNode } from "react";
import { OG_FONT } from "./ogFont";

/** 免责声明已并进卡片原有标题行，这里只包一层画布。 */
export function CardWithDisclaimer({ children, width, contentHeight, background }: {
  children: ReactNode; width: number; contentHeight: number; background: string; color: string; border: string;
}) {
  return <div style={{ display: "flex", flexDirection: "column", width, height: contentHeight,
    background, fontFamily: OG_FONT }}>
    {children}
  </div>;
}
