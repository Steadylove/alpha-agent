import { STRATEGY_NAME, STRATEGY_TAGLINE } from "./brand";
import { alertCardFields, alertTimeframeSuffix, type AlertView } from "./tvAlertCopy";
import { formatFundRatio } from "@/lib/scoring/fundScore";
import { signalTradeChartLabels, signalTradeChartNote, TRADE_CHART_HEIGHT, type SignalTradeChart } from "./signalTradeChart";

export const SIGNAL_CARD_WIDTH = 960;
export const SIGNAL_CARD_SCALE = 2;
export const SIGNAL_INK = {
  bg: "#0B1117", panel: "#121C25", line: "#293641", text: "#F0F4F7",
  secondary: "#B6C3CD", muted: "#8C9EAE", buy: "#65DBAF", take: "#EBC47F", stop: "#F093A0", sell: "#B6C3CD",
};
export type SignalCardItem =
  | { type: "rect"; x: number; y: number; width: number; height: number; fill: string; radius?: number; stroke?: string }
  | { type: "text"; x: number; y: number; width: number; height: number; text: string; size: number; color: string; weight: 400 | 700; align: "left" | "right" | "center"; numeric?: boolean }
  | { type: "chart"; x: number; y: number; chart: SignalTradeChart };

function readableText(text: string): string {
  // 仅改展示用语，兼容已经冻结的评分文本，不改入场快照或评分结果。
  return text.replace(/(\d+(?:\.\d+)?) ATR\b/g, "$1 倍平均波幅").replace(/\bATR\b/g, "波动数据");
}
/** 保守字宽估计用于固定图片换行；正文不靠裁切隐藏。 */
function textWidth(text: string, size: number): number {
  return Array.from(text).reduce((w, ch) => w + size * (/[\u0000-\u00ff]/.test(ch) ? .6 : 1), 0);
}
function wrap(text: string, size: number, width: number): string[] {
  text = readableText(text);
  const lines: string[] = [];
  let line = "";
  for (const char of text) {
    if (line && (char === "\n" || textWidth(line + char, size) > width)) { lines.push(line.trim()); line = ""; }
    if (char !== "\n") line += char;
  }
  if (line) lines.push(line.trim());
  return lines;
}
const dateLabel = (t: number) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(t);

/** OG 和 SVG 共用同一份几何布局，尺寸、层级和留白保持一致。 */
export function signalCardLayout(view: AlertView): { width: number; height: number; items: SignalCardItem[] } {
  const T = SIGNAL_INK, accent = T[view.tone];
  const items: SignalCardItem[] = [];
  const left = 40, inner = SIGNAL_CARD_WIDTH - 80;
  const rect = (x: number, y: number, width: number, height: number, fill: string, radius = 0, stroke?: string) =>
    items.push({ type: "rect", x, y, width, height, fill, radius, stroke });
  const text = (value: string, x: number, y: number, width: number, size = 16, color: string = T.secondary, weight: 400 | 700 = 400, align: "left" | "right" | "center" = "left", numeric = false) => {
    value = readableText(value);
    const fittedSize = Math.min(size, width / Math.max(1, textWidth(value, 1)));
    items.push({ type: "text", x, y, width, height: Math.ceil(size * 1.4), text: value, size: fittedSize, color, weight, align, numeric });
  };
  const paragraph = (value: string, y: number, size = 15, color: string = T.secondary, x = left, width = inner, leading = 24): number => {
    const lines = wrap(value, size, width);
    lines.forEach((line, i) => text(line, x, y + i * leading, width, size, color));
    return lines.length * leading;
  };
  const line = (y: number, x = left, width = inner) => rect(x, y, width, 1, T.line);

  rect(left, 0, 56, 3, accent);
  text(view.symbol, left, 15, 490, 54, T.text, 700, "left", true);
  text(STRATEGY_NAME, 625, 26, 295, 13, T.secondary, 700, "right", true);
  text(`${STRATEGY_TAGLINE}${alertTimeframeSuffix(view.tfLabel)}`, 625, 50, 295, 13, T.muted, 400, "right");
  const [title, ...meta] = view.title.split(" · ");
  const badgeWidth = Math.ceil(textWidth(view.code, 14)) + 18;
  rect(left, 90, badgeWidth, 25, T.panel, 4, accent);
  text(view.code, left, 92.5, badgeWidth, 14, accent, 700, "center", true);
  text(title, left + badgeWidth + 14, 86, 400, 22, accent, 700);
  const context = meta.join(" · ") || (view.chart ? `${dateLabel(view.chart.signalTime)} · 美东收盘信号` : "");
  if (context) text(context, 500, 92, 420, 14, T.muted, 400, "right");
  line(130);

  const fields = alertCardFields(view);
  const primary = fields.filter((f) => ["price", "stop", "entry", "pnl"].includes(f.role));
  const atr = fields.find((f) => f.role === "atr");
  if (primary.length < 3 && atr) primary.push(atr);
  const col = inner / Math.max(primary.length, 1);
  primary.forEach((f, i) => {
    const x = left + i * col;
    text(f.label, x, 151, col - 24, 16, T.secondary);
    const color = f.role === "pnl" ? (view.pnl! < 0 ? T.stop : T.buy) : T.text;
    text(f.value, x, 177, col - 24, f.role === "atr" ? 32 : 38, color, 700, "left", f.role !== "atr");
    if (f.sub) text(f.sub, x, 231, col - 24, 14, T.muted);
    if (i > 0) rect(x - 20, 153, 1, 72, T.line);
  });
  let y = primary.some((f) => f.sub) ? 263 : 244;
  const secondary = fields.filter((f) => ["strength", "fund"].includes(f.role) || (f.role === "atr" && !primary.includes(f)));
  if (secondary.length) {
    const w = inner / secondary.length;
    secondary.forEach((f, i) => {
      const x = left + i * w;
      text(f.role === "strength" ? "相对大池" : f.label, x, y, w - 20, 14, T.muted);
      text(f.value, x, y + 25, w - 24, 21, T.secondary, 700);
      if (f.role === "strength") {
        const track = Math.min(124, w - 168);
        if (track > 0) {
          rect(x + 144, y + 39, track, 3, T.line, 1);
          rect(x + 144, y + 39, track * Math.max(0, Math.min(100, view.rps!)) / 100, 3, accent, 1);
        }
      } else if (f.role === "atr" && f.sub) {
        text(f.sub, x, y + 56, w - 24, 13, T.muted);
      } else if (f.sub) text(f.sub, x + 112, y + 29, w - 132, 14, T.muted);
    });
    y += secondary.some((f) => f.role === "atr") ? 94 : 72;
  }

  const panel = view.assessment;
  if (panel && view.quality) {
    const q = view.quality;
    const summaries = panel.lines.slice(1).flatMap((s) => wrap(s, 15, inner - 40));
    const h = 165 + summaries.length * 24;
    rect(left, y, inner, h, T.panel, 12, T.line);
    text(panel.heading, left + 20, y + 16, 180, 14, T.secondary);
    text(q.available ? `${q.points}` : "—", left + 20, y + 43, 170, 42, T.text, 700, "left", true);
    text(q.available ? `/ ${q.available} · ${q.label}` : q.label, left + 22, y + 106, 177, 14, T.secondary);
    const start = left + 216, w = (inner - 236) / 5;
    q.dimensions.forEach((d, i) => {
      const x = start + i * w;
      text(d.name, x, y + 28, w - 18, 15, T.secondary);
      text(d.points == null ? "—" : String(d.points), x, y + 57, w - 18, 26, d.points == null ? T.muted : T.text, 700, "left", true);
      text(`/ ${d.max}`, x + 75, y + 65, w - 89, 12, T.muted);
      rect(x, y + 108, w - 22, 3, T.line, 1);
      if (d.points != null && d.points > 0) rect(x, y + 108, (w - 22) * d.points / d.max, 3, accent, 1);
    });
    line(y + 136, left + 20, inner - 40);
    summaries.forEach((s, i) => text(s, left + 20, y + 147 + i * 24, inner - 40, 15, T.secondary));
    y += h + 20;
  } else if (panel) {
    // 冻结复盘仍沿用保存时的事实文本；仅将已知格式拆成整齐的指标列。
    const duration = panel.lines[0]?.match(/(\d+) 根\s*·\s*([\d.]+) 天/);
    const risk = panel.lines[0]?.match(/风险收益\s+([+-][\d.]+ R)/);
    const range = panel.lines[1]?.match(/最大浮盈\s+([+-][\d.]+%)\s*·?\s*最大浮亏\s+([+-][\d.]+%)\s*·?\s*回吐\s+([\d.]+) 个百分点/);
    const structured = Boolean(duration && risk && range);
    const body = (structured ? panel.lines.slice(2) : panel.lines).flatMap((s) => wrap(s, 15, inner - 40));
    const h = (structured ? 181 : 89) + body.length * 24;
    rect(left, y, inner, h, T.panel, 12, T.line);
    text("交易复盘", left + 20, y + 18, 220, 16, T.text, 700);
    text(panel.headline.split(" → ")[0], left + 265, y + 18, inner - 285, 18, T.secondary, 400, "right");
    if (structured) {
      const stats = [
        ["持仓", `${duration![2]} 天`, `${duration![1]} 根 K 线`],
        ["风险收益", risk![1], "初始风险单位"],
        ["最大浮盈", range![1], "持仓内最高"],
        ["最大浮亏", range![2], "持仓内最低"],
        ["盈利回吐", range![3], "个百分点"],
      ];
      stats.forEach(([name, value, sub], i) => {
        const w = (inner - 40) / 5, x = left + 20 + i * w;
        text(name, x, y + 62, w - 14, 14, T.muted);
        text(value, x, y + 87, w - 14, 23, T.text, 700);
        text(sub, x, y + 125, w - 14, 12, T.muted);
      });
      line(y + 159, left + 20, inner - 40);
    }
    body.forEach((s, i) => text(s, left + 20, y + (structured ? 172 : 64) + i * 24, inner - 40, 15, T.secondary));
    y += h + 20;
  }
  if (view.footer) {
    rect(left, y + 7, 3, 15, accent, 1);
    y += paragraph(view.footer, y, 15, T.secondary, left + 14, inner - 14) + 14;
  }

  if (view.chart) {
    text("价格走势", left, y, 200, 16, T.text, 700);
    text(`${dateLabel(view.chart.bars[0][0])} — ${dateLabel(view.chart.signalTime)}`, 560, y + 2, 360, 13, T.muted, 400, "right");
    y += 33;
    items.push({ type: "chart", x: left, y, chart: view.chart });
    for (const label of signalTradeChartLabels(view.chart)) {
      const item: SignalCardItem = { type: "text", x: left + label.x, y: y + label.y, width: label.width,
        height: label.height ?? 20, text: label.text, size: label.fontSize ?? 13, color: label.color,
        weight: label.fontWeight ?? 400, align: label.align ?? "left" };
      items.push(item);
    }
    y += TRADE_CHART_HEIGHT + 12;
    y += paragraph(signalTradeChartNote(view.chart), y, 13, T.muted, left, inner, 21);
    y += 16;
  }
  if (view.fund?.usable) {
    line(y);
    y += 15;
    text("财务与位置概览", left, y, 230, 14, T.secondary, 700);
    y += 25;
    const col = inner / 3;
    view.fund.dims.forEach((d, i) => {
      const x = left + (i % 3) * col, top = y + Math.floor(i / 3) * 29;
      text(d.label, x, top, 88, 13, T.muted);
      text(d.value == null ? "—" : formatFundRatio(d.id, d.value), x + 93, top - 1, 101, 14, T.secondary, 700);
      text(d.value == null ? "缺" : `${d.points}/${d.max}`, x + 205, top, 64, 13, T.muted);
    });
    y += 66;
  }
  if (panel) {
    line(y);
    y += 12;
    y += paragraph(panel.note, y, 13, T.muted, left, inner, 21);
  }
  return { width: SIGNAL_CARD_WIDTH, height: Math.ceil(y + 24), items };
}
