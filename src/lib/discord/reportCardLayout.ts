import { STRATEGY_NAME, STRATEGY_TAGLINE } from "./brand";
import { CARD_INK as T, CARD_WIDTH } from "./cardTheme";
import { withDisclaimer } from "./cardDisclaimer";

export type ReportCardItem =
  | { type: "rect"; x: number; y: number; width: number; height: number; fill: string; radius: number; stroke?: string }
  | { type: "text"; x: number; y: number; width: number; height: number; text: string; size: number; color: string; weight: 400 | 700; align: "left" | "right" | "center"; numeric: boolean }
  | { type: "path"; x: number; y: number; width: number; height: number; d: string; color: string };
export type ReportCardLayout = { width: number; height: number; items: ReportCardItem[] };

const textWidth = (value: string, size: number) => Array.from(value).reduce((w, c) => w + size * (/[\u0000-\u00ff]/.test(c) ? .62 : 1), 0);

/** 账本的 OG / SVG 和期权流使用相同布局单位、留白和字宽约束。 */
export function reportCard() {
  const items: ReportCardItem[] = [];
  const rect = (x: number, y: number, width: number, height: number, fill: string, radius = 0, stroke?: string) => {
    items.push({ type: "rect", x, y, width, height, fill, radius, stroke });
  };
  const text = (value: string, x: number, y: number, width: number, size = 16, color: string = T.secondary,
    weight: 400 | 700 = 400, align: "left" | "right" | "center" = "left", numeric = false) => {
    items.push({ type: "text", x, y, width, height: Math.ceil(size * 1.4), text: value,
      size: Math.min(size, width / Math.max(1, textWidth(value, 1))), color, weight, align, numeric });
  };
  const line = (y: number, x = 40, width = 880) => rect(x, y, width, 1, T.line);
  const header = (title: string, badge: string, subtitle: string, meta: string, accent: string, titleSize = 42) => {
    rect(40, 0, 56, 3, accent);
    text(title, 40, 15, 545, titleSize, T.text, 700, "left", /^[A-Z.\d-]+$/.test(title));
    text(STRATEGY_NAME, 625, 26, 295, 13, T.secondary, 700, "right", true);
    text(STRATEGY_TAGLINE, 625, 50, 295, 13, T.muted, 400, "right");
    const badgeWidth = Math.ceil(textWidth(badge, 14)) + 18;
    rect(40, 90, badgeWidth, 25, T.panel, 4, accent);
    text(badge, 40, 92.5, badgeWidth, 14, accent, 700, "center", true);
    text(subtitle, 40 + badgeWidth + 14, 89, 280, 18, accent, 700);
    text(withDisclaimer(meta), 480, 94, 440, 13, T.muted, 400, "right");
    line(130);
  };
  return { items, rect, text, line, header,
    finish: (height: number): ReportCardLayout => ({ width: CARD_WIDTH, height: Math.ceil(height), items }) };
}
