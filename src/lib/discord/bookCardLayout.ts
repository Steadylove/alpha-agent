import { bookPnlLabel, daysOpenLabel, daysOpenOf, pnlLabel, winRateLabel, type CashBookView } from "./bookCopy";
import { CARD_INK as T } from "./cardTheme";
import { reportCard } from "./reportCardLayout";
import { strengthLabel } from "./tvAlertCopy";

function bookTitle(label: string): string {
  if (/现金账本[12]/.test(label)) return label.match(/现金账本[12]/)![0];
  if (/4\s*(小时|h)/i.test(label)) return "现金账本1";
  if (/2\s*(小时|h)/i.test(label)) return "现金账本2";
  return label || "现金账本";
}

/** 原净值点按顺序连线，不平滑、不补造收益；缺失区间不跨越连线。 */
function curvePath(values: readonly number[], width: number, height: number): string {
  const finite = values.filter(Number.isFinite);
  if (finite.length < 2) return "";
  const min = Math.min(...finite), max = Math.max(...finite), span = max - min;
  let connected = false;
  return values.map((value, i) => {
    if (!Number.isFinite(value)) { connected = false; return ""; }
    const x = 4 + i / (values.length - 1) * (width - 8);
    const y = span === 0 ? height / 2 : 6 + (max - value) / span * (height - 12);
    const command = connected ? "L" : "M";
    connected = true;
    return `${command}${x.toFixed(2)} ${y.toFixed(2)}`;
  }).join(" ");
}

export function cashBookLayout(input: CashBookView) {
  const card = reportCard(), { text, rect, line } = card;
  const cashPct = Math.max(0, 100 - input.exposurePct);
  const gainColor = (v: number | null | undefined) => v == null ? T.text : v >= 0 ? T.buy : T.stop;
  const equityColor = gainColor(input.equity == null ? null : input.equity - 1);
  const asOf = input.asOf.replace("T", " ").slice(0, 16);
  card.header(bookTitle(input.label), "NAV", "持仓快照", `截至 ${asOf}`, T.buy);

  rect(40, 150, 880, 178, T.panel, 12, T.line);
  text("累计收益", 60, 166, 300, 16, T.secondary);
  text(input.equity == null ? "—" : bookPnlLabel(input.equity), 60, 196, 308, 48, equityColor, 700, "left", true);
  text(`记账自 ${input.since.slice(0, 10)}`, 62, 280, 300, 14, T.muted);
  rect(374, 174, 1, 127, T.line);
  text("净值走势", 400, 163, 200, 14, T.secondary);
  const d = curvePath(input.curve ?? [], 496, 104);
  if (d) {
    card.items.push({ type: "path", x: 400, y: 191, width: 496, height: 104, d, color: equityColor });
  } else {
    text("净值记录不足，暂不绘制", 400, 226, 496, 15, T.muted, 400, "center");
  }
  text(input.since.slice(0, 10), 400, 300, 190, 11, T.muted);
  text(input.asOf.slice(0, 10), 706, 300, 190, 11, T.muted, 400, "right");

  const kpis = [
    { label: input.ytdYear ? `${input.ytdYear} YTD · 年内收益` : "YTD · 年内收益", value: input.ytdPct == null ? "—" : pnlLabel(input.ytdPct), color: gainColor(input.ytdPct) },
    { label: "最大回撤", value: input.dd == null ? "—" : `${input.dd.toFixed(0)}%`, color: T.stop },
    { label: "胜率", value: winRateLabel(input.winRatePct), color: T.text },
    { label: "相对 QQQ · 百分点", value: input.vsQqqPct == null ? "—" : `${input.vsQqqPct >= 0 ? "+" : ""}${input.vsQqqPct.toFixed(1)}`, color: gainColor(input.vsQqqPct) },
  ];
  kpis.forEach((kpi, i) => {
    const x = 40 + i * 220;
    text(kpi.label, x, 347, 206, 14, T.muted);
    text(kpi.value, x, 373, 204, 29, kpi.color, 700, "left", true);
  });
  line(430);

  const columns = [
    { title: "#", x: 52, width: 34 }, { title: "代码", x: 100, width: 112 },
    { title: "持仓天数", x: 220, width: 106 }, { title: "仓位", x: 336, width: 94, end: true },
    { title: "开仓价格", x: 452, width: 144, end: true }, { title: "盈亏比例", x: 617, width: 140, end: true },
    { title: "强度", x: 778, width: 130, end: true },
  ];
  columns.forEach((c) => text(c.title, c.x, 444, c.width, 13, T.muted, 400, c.end ? "right" : "left"));
  const rowH = 52, startY = 478;
  line(startY - 1);
  if (!input.rows.length) {
    text("空仓 · 当前没有持仓", 40, startY + 16, 880, 18, T.secondary, 400, "center");
  }
  input.rows.forEach((row, i) => {
    const y = startY + i * rowH;
    if (i % 2 === 1) rect(40, y, 880, rowH, T.panel, 6);
    const values = [String(i + 1).padStart(2, "0"), row.symbol, daysOpenLabel(daysOpenOf(row.entryDate, input.asOf)),
      `${row.weightPct.toFixed(1)}%`, `$${row.entryPrice.toFixed(2)}`, pnlLabel(row.floatPnlPct),
      row.rps != null && row.rps >= 1 ? strengthLabel(row.rps) : "—"];
    columns.forEach((col, j) => text(values[j], col.x, y + 13, col.width, j === 0 ? 13 : j === 6 ? 14 : 17,
      j === 5 ? gainColor(row.floatPnlPct) : j === 0 ? T.muted : j === 1 ? T.text : T.secondary,
      j === 1 || j === 5 ? 700 : 400, col.end ? "right" : "left", [0, 1, 3, 4, 5].includes(j)));
  });
  const footerY = startY + Math.max(input.rows.length, 1) * rowH + 22;
  line(footerY - 6);
  text(`持仓 ${input.rows.length} 只`, 40, footerY + 9, 180, 16, T.secondary);
  text(`敞口 ${input.exposurePct.toFixed(0)}%`, 270, footerY + 9, 280, 18, T.buy, 700, "center");
  text(`现金 ${cashPct.toFixed(0)}%`, 680, footerY + 9, 240, 18, T.take, 700, "right");
  rect(40, footerY + 49, 880, 5, T.line, 2);
  const exposure = Math.max(0, Math.min(100, input.exposurePct));
  if (exposure) rect(40, footerY + 49, 880 * exposure / 100, 5, T.buy, 2);
  const details = [
    input.mar == null ? null : `MAR ${input.mar.toFixed(2)}`,
    input.avgHoldings == null ? null : `均持 ${input.avgHoldings.toFixed(1)} 只`,
    input.avgExposure == null ? null : `平均敞口 ${input.avgExposure.toFixed(0)}%`,
  ].filter(Boolean);
  if (details.length) text(details.join("   ·   "), 40, footerY + 70, 880, 13, T.muted);
  return card.finish(footerY + (details.length ? 112 : 82));
}
