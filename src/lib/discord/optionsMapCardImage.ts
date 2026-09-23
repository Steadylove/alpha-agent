import type { DailyReview } from "@/lib/review/types";
import { optionsStructure, FLIP_LABEL, WALL_LABEL, GAMMA_LABEL } from "@/lib/options/structure";
import { C, createReportCanvas, finite, num, signed, ink, reportWordmark } from "./reportCanvas";

export type OptionsMapBar = { date: string; open: number; high: number; low: number; close: number };
export type OptionsMapProfile = {
  date: string; asOf: string; spot: number; netGex: number; source: string; method: string; dte: string;
  rows: { strike: number; call_gex: number; put_gex: number; net_gex: number }[];
};
const billions = (n: number | null | undefined) => finite(n) ? `${n < 0 ? "−" : "+"}$${num(Math.abs(n) / 1e9)}B` : "—";

/** Frozen, date-aligned inputs only. This renderer never fetches or sends a message. */
export function optionsMapCardSvg(review: DailyReview, bars: OptionsMapBar[], profile: OptionsMapProfile, logo: string) {
  const { out, rect, line, text, paragraph, pill, section, finish } = createReportCanvas(1920, 1440);
  const options = ["SPX", "SPY", "QQQ", "IWM"].map(symbol => {
    const row = review.options.find(r => r.symbol === symbol);
    return { symbol, row, s: row?.structure ?? optionsStructure(row?.today ?? null) };
  });
  const market = (symbol: string) => review.market.metrics.find(m => m.symbol === symbol);
  const spx = options[0], values = spx.s.values;
  const candles = bars.filter(b => b.date <= review.date).sort((a, b) => a.date.localeCompare(b.date)).slice(-45);
  if (candles.length < 10 || candles.at(-1)?.date !== review.date) throw new Error("SPX 日线没有覆盖复盘日期");
  if (profile.date !== review.date || profile.asOf !== spx.row?.today?.as_of || profile.method !== spx.row?.meta?.method_version || profile.dte !== spx.row?.dte) throw new Error("Gamma 分布与复盘快照的日期、口径不一致");
  if (!finite(values.spot) || !finite(values.net_gex) || Math.abs(profile.spot - values.spot) > .01 || Math.abs(profile.netGex - values.net_gex) > 100) throw new Error("Gamma 分布与快照数值不一致");
  if (Math.abs(candles.at(-1)!.close - values.spot) > 1) throw new Error("日线收盘与期权快照价格不一致");

  out.push(`<rect width="1920" height="1440" fill="${C.bg}"/>`);
  rect(48, 0, 94, 3, C.accent, "none", 0);
  out.push(`<g transform="translate(48 36)">${logo}</g>`);
  out.push(reportWordmark("brand", 153, 79, 32, C.white));
  text("趋势自适应系统", 156, 111, 17, C.muted);
  out.push(`<path d="M512 44V125" stroke="${C.line}"/>`);
  out.push(reportWordmark("options", 552, 86, 47, C.white));
  text("期权结构地图 · 价格位置与 Gamma 分布", 556, 121, 19, C.secondary);
  text("REVIEW / 复盘交易日", 1480, 54, 14, C.muted, 500);
  text(review.date, 1480, 86, 26, C.white, 600, 390, "start", true);
  text("US MARKET  /  收盘结构快照", 1480, 119, 17, C.accent, 500);

  rect(48, 157, 1824, 107, C.panel2);
  text("市场结构总览", 72, 184, 15, C.muted);
  const above = options.filter(o => o.s.flip === "above").map(o => o.symbol);
  const negative = options.filter(o => o.s.gamma === "negative").map(o => o.symbol);
  text(above.length ? `${above.join(" / ")} 位于 Flip 上方` : "关键位置待确认", 72, 218, 23, C.white, 600, 600);
  text(negative.length ? `${negative.join(" / ")} 净 GEX 为负 · 价格位置与 GEX 分开判断` : "价格位置与 GEX 分开判断", 72, 247, 16, C.secondary, 400, 600);
  options.forEach(({ symbol }, i) => {
    const x = 742 + i * 282;
    out.push(`<path d="M${x - 24} 179V243" stroke="${C.line}"/>`);
    text(symbol, x, 185, 17, C.secondary, 500);
    text(num(market(symbol)?.today), x, 219, 28, C.white, 600, 232);
    text(`${signed(market(symbol)?.change)}  当日`, x, 246, 16, ink(market(symbol)?.change), 500);
  });

  section("01", "SPX 结构剖面", "PRICE & GAMMA PROFILE", 311, "日线 · Cboe 延迟期权链 · DTE 0–45 天");
  rect(48, 338, 1376, 542);
  text("SPX", 72, 380, 27, C.white, 700);
  text(num(values.spot), 150, 380, 27, C.white, 600);
  text("收盘参考价", 333, 378, 14, C.muted);
  [
    { x: 660, name: "Gamma Flip", value: values.gamma_flip, color: C.gold },
    { x: 874, name: "Put Wall", value: values.put_wall, color: C.accent },
    { x: 1088, name: "Call Wall", value: values.call_wall, color: C.secondary },
  ].forEach(s => { text(s.name, s.x, 366, 14, C.muted); text(num(s.value), s.x, 394, 21, s.color, 500, 180, "start", true); });
  line(72, 411, 1328);

  // Both plots share a price axis. Reserve a gutter for collision-free level labels.
  const plot = { x: 128, y: 449, w: 822, h: 344 }, plotBottom = plot.y + plot.h;
  const levels = [values.gamma_flip, values.put_wall, values.call_wall, values.spot].filter(finite);
  const min = Math.floor((Math.min(...candles.map(b => b.low), ...levels) - 18) / 50) * 50;
  const max = Math.ceil((Math.max(...candles.map(b => b.high), ...levels) + 18) / 50) * 50;
  const py = (v: number) => plotBottom - (v - min) / (max - min) * plot.h;
  text(`SPX · ${candles.length} 个交易日日线`, 128, 436, 13, C.muted);
  text("净 GEX / 行权价", 1167, 436, 13, C.muted);
  const gridStep = max - min > 450 ? 100 : 50;
  for (let p = min; p <= max; p += gridStep) {
    line(plot.x, py(p), 1268, C.line);
    text(num(p, 0), 113, py(p), 13, C.muted, 400, 58, "end", false, py(p));
  }
  const flip = values.gamma_flip, put = values.put_wall, call = values.call_wall;
  if (finite(put) && finite(call) && call > put) out.push(`<rect x="${plot.x}" y="${py(call)}" width="982" height="${py(put) - py(call)}" fill="${C.accent}" opacity=".055"/>`);
  const step = plot.w / candles.length;
  candles.forEach((b, i) => {
    const x = plot.x + (i + .5) * step, color = b.close >= b.open ? C.green : C.red;
    out.push(`<path d="M${x} ${py(b.high)}V${py(b.low)}" stroke="${color}" stroke-width="1.4"/>`);
    rect(x - step * .27, Math.min(py(b.open), py(b.close)), step * .54, Math.max(1.6, Math.abs(py(b.open) - py(b.close))), color, "none", .6);
    if (i % 10 === 0 || i === candles.length - 1) text(b.date.slice(5), x, 822, 13, C.muted, 400, 90, "middle");
  });
  const marked = [
    { name: "Call Wall", value: call, color: C.secondary, dash: "6 4" },
    { name: "Put Wall", value: put, color: C.accent, dash: "6 4" },
    { name: "Gamma Flip", value: flip, color: C.gold, dash: "3 5" },
  ].filter((r): r is typeof r & { value: number } => finite(r.value)).sort((a, b) => b.value - a.value);
  let lastY = plot.y - 36;
  marked.forEach(r => {
    const realY = py(r.value), labelY = Math.max(realY, lastY + 38); lastY = labelY;
    out.push(`<path d="M${plot.x} ${realY}H960" stroke="${r.color}" opacity=".72" stroke-width="1.2" stroke-dasharray="${r.dash}"/>`);
    out.push(`<path d="M950 ${realY}H968L980 ${labelY}H991" fill="none" stroke="${r.color}" opacity=".8"/>`);
    text(r.name, 997, labelY - 7, 12, r.color, 500);
    text(num(r.value), 997, labelY + 13, 15, C.white, 500, 111, "start", true);
  });
  const lastX = plot.x + (candles.length - .5) * step;
  out.push(`<circle cx="${lastX}" cy="${py(values.spot)}" r="4" fill="${C.white}" stroke="${C.bg}" stroke-width="1.5"/>`);

  // 10-point strike bins, signed and linear; never substitute a volume profile.
  const bins = new Map<number, number>();
  profile.rows.forEach(r => { const k = Math.floor(r.strike / 10) * 10 + 5; bins.set(k, (bins.get(k) ?? 0) + r.net_gex); });
  const visibleBins = [...bins].filter(([k]) => k >= min && k <= max);
  const absMax = Math.max(...visibleBins.map(([, g]) => Math.abs(g)), 1);
  const zeroX = 1272, half = 118;
  out.push(`<path d="M1142 449V793 M${zeroX} 449V793" stroke="${C.line}"/>`);
  visibleBins.forEach(([k, gex]) => {
    const w = Math.abs(gex) / absMax * half, h = Math.max(1.5, 10 / (max - min) * plot.h - 1.5);
    rect(gex < 0 ? zeroX - w : zeroX, py(k) - h / 2, w, h, gex < 0 ? C.red : C.accent, "none", .6);
  });
  text("−", 1154, 817, 15, C.red); text("0", zeroX, 817, 13, C.muted, 400, 20, "middle"); text("+", 1390, 817, 15, C.accent, 400, 20, "end");
  text(`两侧同尺 · 最大 ${num(absMax / 1e9, 1)}B`, 1272, 843, 12, C.muted, 400, 245, "middle");
  text("横线为复盘日结构，非历史逐日墙位；白点为最新收盘。", 72, 859, 13, C.muted);
  text("10 点分档 · $B / 现货变动 1%", 1400, 864, 12, C.muted, 400, 320, "end");

  rect(1440, 338, 432, 542, C.panel2);
  text("SPX · 结构状态", 1464, 379, 23, C.white, 600);
  text(billions(values.net_gex), 1464, 432, 39, ink(values.net_gex), 600, 380);
  text("NET GEX  /  净 Gamma 敞口估算", 1464, 462, 14, C.muted);
  line(1464, 481, 384);
  text("价格距离", 1464, 512, 18, C.white, 500);
  [
    { label: "距 Gamma Flip", value: spx.s.distances.flip, digits: 2 },
    { label: "距 Put Wall", value: spx.s.distances.put, digits: 2 },
    { label: "距 Call Wall", value: spx.s.distances.call, digits: 4 },
  ].forEach((r, i) => { text(r.label, 1464, 548 + i * 36, 17, C.secondary); text(signed(r.value, r.digits), 1848, 548 + i * 36, 20, r.label.includes("Call") ? C.gold : C.accent, 500, 182, "end", true); });
  line(1464, 644, 384);
  const p1 = pill(FLIP_LABEL[spx.s.flip], 1464, 667, C.accent, 138);
  pill(WALL_LABEL[spx.s.wall], 1474 + p1, 667, C.gold, 209);
  pill(GAMMA_LABEL[spx.s.gamma], 1464, 706, ink(values.net_gex), 145);
  const focus = spx.s.wall === "near-call" || spx.s.wall === "near-both" ? "价格贴近 Call Wall，跟踪突破后能否站稳，以及 Put Wall 附近的价格反应。"
    : spx.s.wall === "near-put" ? "价格贴近 Put Wall，关注该位置附近的承接与跌破后的价格反应。"
    : spx.s.wall === "above-call" ? "价格已在 Call Wall 上方，关注能否站稳以及墙位后续变化。"
    : spx.s.wall === "below-put" ? "价格已在 Put Wall 下方，关注能否收复该位置以及结构后续变化。"
    : spx.s.wall === "inside" ? "价格处于双墙之间，跟踪向区间边缘靠近时的价格反应。"
    : "当前墙位关系无法确认；保留有效数值，等待结构数据补齐。";
  paragraph(focus, 1464, 770, 380, 17, C.secondary, 3);
  text(`期权报价 ${profile.asOf.slice(11, 19)} ET`, 1464, 857, 13, C.muted);

  section("02", "跨标的结构", "CROSS-ASSET STRUCTURE", 929, "位置、墙位、GEX 独立描述 · 接近阈值 0.2%");
  options.forEach(({ symbol, row, s }, i) => {
    const x = 48 + i * 460, y = 957, w = 444;
    rect(x, y, w, 262);
    const accent = s.gamma === "negative" ? C.red : C.accent;
    rect(x + 1, y + 22, 3, 30, accent, "none", 1);
    text(symbol, x + 22, y + 41, 27, C.white, 700);
    text(num(s.values.spot), x + 422, y + 41, 24, C.white, 600, 215, "end");
    line(x + 22, y + 59, w - 44);
    [
      ["Gamma Flip", num(s.values.gamma_flip)], ["Put Wall", num(s.values.put_wall)],
      ["Call Wall", num(s.values.call_wall)], ["Net GEX", billions(s.values.net_gex)],
    ].forEach(([label, value], j) => { text(label, x + 22, y + 89 + j * 30, 16, C.secondary); text(value, x + 422, y + 89 + j * 30, 18, j === 3 ? accent : C.white, 500, 210, "end", true); });
    const pw = pill(FLIP_LABEL[s.flip], x + 22, y + 196, s.flip === "below" ? C.red : C.accent, 130);
    pill(WALL_LABEL[s.wall], x + 32 + pw, y + 196, s.wall === "near-call" ? C.gold : C.accent, 204);
    text(`${GAMMA_LABEL[s.gamma]} · 报价 ${row?.today?.as_of?.slice(11, 19) ?? "—"} ET`, x + 22, y + 246, 12, C.muted);
  });

  rect(48, 1239, 742, 124, C.panel2);
  text("03", 72, 1275, 19, C.accent, 600, 40, "start", true);
  text("结构迁移", 118, 1275, 22, C.white, 600);
  text("STRUCTURE SHIFT", 228, 1274, 15, C.muted, 500, 260, "start", false, 1267);
  const verified = options.filter(o => o.row?.comparison === "verified" && o.row.comparable);
  if (!verified.length) {
    text("前日口径待核验", 766, 1274, 15, C.gold, 500, 220, "end", false, 1267);
    paragraph("前日快照缺少计算口径记录，暂不标注墙位迁移及 GEX 转向；今日数值可查看。", 72, 1314, 690, 16, C.secondary, 2);
  } else {
    const changes = verified.flatMap(o => o.row!.changes.map(c => `${o.symbol}  ${c}`));
    paragraph(changes.join("；") || "可比字段未见结构变化。", 72, 1314, 690, 16, C.secondary, 2);
  }
  rect(806, 1239, 518, 124);
  text("观察重点", 830, 1275, 21, C.white, 600);
  const nearCall = options.filter(o => ["near-call", "near-both"].includes(o.s.wall)).map(o => o.symbol);
  paragraph(`${nearCall.length ? `${nearCall.join(" / ")} 接近 Call Wall` : "暂无标的贴近 Call Wall"}；${negative.length ? `${negative.join(" / ")} 净 GEX 为负` : "暂无负 GEX 标的"}。`, 830, 1314, 470, 16, C.secondary, 2);
  rect(1340, 1239, 532, 124);
  text("数据口径", 1364, 1275, 21, C.white, 600);
  paragraph("Cboe 延迟链 · 0–45 DTE。GEX 采用 Call 正、Put 负的 OI 代理模型，不等同于做市商真实持仓。", 1364, 1314, 484, 16, C.muted, 2);
  line(48, 1380, 1824);
  out.push(reportWordmark("brand", 48, 1410, 16, C.accent));
  text("/  趋势自适应系统", 224, 1410, 14, C.muted);
  text("仅供信息参考，不构成投资建议", 960, 1410, 14, C.muted, 400, 620, "middle");
  text(`${review.date} · 美东时间 ET · 02 / 02`, 1872, 1410, 14, C.muted, 400, 430, "end");
  return finish();
}
