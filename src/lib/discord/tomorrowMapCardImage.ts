import type { DailyReview } from "@/lib/review/types";
import { optionsStructure, FLIP_LABEL, WALL_LABEL } from "@/lib/options/structure";
import { STRATEGY_TAGLINE } from "./brand";
import detailFontData from "./fonts/ChakraPetch-glyphs.json";
import { reportWordmark } from "./reportCanvas";

// Standalone preview: frozen review data only; no fetches, scores, or notifications.
const W = 1920, H = 1440;
// Match globals.css and the daily-review / options-map homepage palettes.
const C = {
  bg: "#101114", panel: "#151B1C", panel2: "#14201E", line: "#2B3434",
  white: "#E8ECE9", secondary: "#BCC8C4", muted: "#97A09E",
  accent: "#9ED6BC", green: "#89D6B0", red: "#F59A95", gold: "#DBC08C",
};
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
const num = (n: number | null | undefined, d = 2) => finite(n) ? n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d }) : "—";
const signed = (n: number | null | undefined, d = 2, unit = "%") => finite(n) ? `${Math.abs(n) < .5 * 10 ** -d ? "" : n > 0 ? "+" : "−"}${num(Math.abs(n), d)}${unit}` : "—";
const ink = (n: number | null | undefined) => !finite(n) || Math.abs(n) < .005 ? C.secondary : n >= 0 ? C.green : C.red;
const widthOf = (s: string, size: number) => Array.from(s).reduce((a, c) => a + size * (/[\u0000-\u00ff]/.test(c) ? .60 : 1.025), 0);
const DETAIL_FONT = "Chakra Petch, Hiragino Sans GB, Noto Sans CJK SC, sans-serif";
type OutlineFont = { unitsPerEm: number; capCenter: number; glyphs: Record<string, { advance: number; path: string }> };

export function tomorrowMapCardSvg(review: DailyReview, history: DailyReview[], logoSvg: string, sample = false): string {
  const out: string[] = [];
  const glyphDefs = new Map<string, string>();
  const rect = (x: number, y: number, w: number, h: number, fill = C.panel, stroke = C.line, r = 4) =>
    out.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${fill}" stroke="${stroke}"/>`);
  const line = (x: number, y: number, w: number, color = C.line) => out.push(`<path d="M${x} ${y}h${w}" stroke="${color}"/>`);
  const text = (s: string, x: number, y: number, size = 18, color = C.secondary, weight = 400, max = 10000, anchor = "start", mono = false, centerY?: number) => {
    const detail = size <= 18 && !mono;
    if (detail) {
      // Latin outlines avoid silent platform font substitution and align caps to CJK centers.
      const weightKey = weight >= 500 ? "500" : "400";
      const font = detailFontData[weightKey] as OutlineFont;
      const chars = Array.from(s), tracking = .025;
      const units = chars.reduce((sum, ch) => sum + (font.glyphs[ch]?.advance ?? font.unitsPerEm) / font.unitsPerEm + tracking, 0) - tracking;
      const fit = Math.min(size, max / Math.max(units, 1));
      const center = centerY ?? y - size * .38;
      let cursor = x - units * fit * (anchor === "end" ? 1 : anchor === "middle" ? .5 : 0);
      out.push(`<g fill="${color}" aria-label="${esc(s)}">`);
      for (const ch of chars) {
        const glyph = font.glyphs[ch];
        if (glyph) {
          const id = `detail-${weightKey}-${ch.codePointAt(0)!.toString(16)}`;
          if (glyph.path) {
            glyphDefs.set(id, `<path id="${id}" d="${glyph.path}"/>`);
            const scale = fit / font.unitsPerEm;
            out.push(`<use href="#${id}" transform="translate(${cursor} ${center + font.capCenter * scale}) scale(${scale} ${-scale})"/>`);
          }
          cursor += (glyph.advance / font.unitsPerEm + tracking) * fit;
        } else {
          out.push(`<text x="${cursor}" y="${center}" dominant-baseline="central" font-size="${fit}" font-weight="400" font-family="Hiragino Sans GB, Noto Sans CJK SC, sans-serif">${esc(ch)}</text>`);
          cursor += (1 + tracking) * fit;
        }
      }
      out.push("</g>");
      return;
    }
    const fit = Math.min(size, size * max / Math.max(widthOf(s, size), 1));
    const font = mono ? "Menlo, monospace" : detail ? DETAIL_FONT : "Avenir Next, PingFang SC, Noto Sans CJK SC, sans-serif";
    out.push(`<text xml:space="preserve" x="${x}" y="${centerY ?? y}"${centerY != null ? ' dominant-baseline="central" alignment-baseline="central"' : ""} font-size="${fit}" font-weight="${weight}" fill="${color}" text-anchor="${anchor}" font-family="${font}">${esc(s)}</text>`);
  };
  const paragraph = (s: string, x: number, y: number, max: number, size = 18, color = C.secondary, limit = 3) => {
    const lines: string[] = []; let row = "";
    // Keep tickers, dates, and numeric values together when wrapping CJK text.
    for (const c of s.match(/[A-Za-z0-9][A-Za-z0-9.%/+−-]*|\s+|./gu) ?? []) {
      if (row && widthOf(row + c, size) > max && !/^[，。；：！？、）]/u.test(c)) { lines.push(row); row = ""; }
      if (row || c.trim()) row += c;
    }
    if (row) lines.push(row);
    lines.slice(0, limit).forEach((value, i) => text(i === limit - 1 && lines.length > limit ? value.slice(0, -1) + "…" : value, x, y + i * (size + 10), size, color));
  };
  const pill = (s: string, x: number, y: number, color: string, max = 180) => {
    const w = Math.min(widthOf(s, 15) + 22, max);
    rect(x, y, w, 28, C.panel2, C.line, 4);
    text(s, x + w / 2, y + 19, 15, color, 500, w - 16, "middle", false, y + 14);
    return w;
  };
  const section = (index: string, title: string, en: string, y: number, detail: string) => {
    const center = y - 9;
    text(index, 48, y, 22, C.accent, 700, 50, "start", true, center);
    text(title, 100, y, 26, C.white, 600, 10000, "start", false, center);
    text(en, 100 + widthOf(title, 26) + 24, y, 18, C.muted, 500, 10000, "start", false, center);
    text(detail, 1872, y, 16, C.muted, 400, 740, "end", false, center);
  };
  const market = (symbol: string) => review.market.metrics.find(x => x.symbol === symbol);
  const options = ["SPX", "SPY", "QQQ", "IWM"].map(symbol => {
    const r = review.options.find(x => x.symbol === symbol);
    return { symbol, row: r, s: r?.structure ?? optionsStructure(r?.today ?? null) };
  });
  const safeHistory = history.filter(r => r.date <= review.date).sort((a, b) => a.date.localeCompare(b.date)).slice(-11);
  const reconstructed = review.tomorrow?.basis !== "published";
  out.push(`<defs>
    <linearGradient id="hero" x1="0" y1="0" x2="1" y2=".7"><stop stop-color="#172522"/><stop offset=".55" stop-color="#141B1B"/><stop offset="1" stop-color="#15191C"/></linearGradient>
  </defs><rect width="${W}" height="${H}" fill="${C.bg}"/>`);
  rect(48, 0, 94, 3, C.accent, "none", 0);
  out.push(`<g transform="translate(48 36)">${logoSvg}</g>`);
  out.push(reportWordmark("brand", 153, 79, 32, C.white));
  text(STRATEGY_TAGLINE, 156, 111, 17, C.muted, 400, 335);
  out.push(`<path d="M512 44V125" stroke="${C.line}"/>`);
  out.push(reportWordmark("tomorrow", 552, 86, 49, C.white));
  text("下一交易日综合观察地图", 556, 121, 21, C.secondary);
  text("REVIEW / 复盘交易日", 1480, 54, 14, C.muted, 600);
  text(review.date, 1480, 86, 26, C.white, 600, 390, "start", true);
  text(`NEXT SESSION  →  ${review.tomorrow?.targetDate ?? "待确认"}`, 1480, 119, 17, C.accent, 500, 390);

  rect(48, 157, 1824, 107, "url(#hero)", C.line);
  const engine = review.market.engine;
  text("今日市场状态", 72, 184, 15, C.muted);
  text(engine?.label ?? review.market.regime, 72, 226, 31, C.white, 600, 240);
  text(engine?.state ?? review.market.regime, 276, 223, 20, C.gold, 600, 210);
  out.push(`<path d="M512 179V242" stroke="${C.line}"/>`);
  const stats = [
    { x: 548, label: "市场上涨比例", value: `${num(review.market.breadth.today, 1)}%`, sub: `${signed(engine?.temperature.delta, 1, " pp")} 较前日`, color: C.gold },
    { x: 890, label: "VIX", value: num(market("VIX")?.today), sub: signed(market("VIX")?.change), color: C.accent },
    { x: 1172, label: "QQQ 相对 SPY", value: signed(engine?.structure.growthSpread, 2, " pp"), sub: "当日涨跌幅之差", color: C.green },
    { x: 1544, label: "上涨板块", value: `${engine?.structure.sectorUp ?? "—"} / ${engine?.structure.sectorTotal ?? "—"}`, sub: "日涨幅超过 0.2%", color: C.white },
  ];
  stats.forEach(s => { text(s.label, s.x, 184, 15, C.muted); text(s.value, s.x, 218, 29, s.color, 600, 310); text(s.sub, s.x, 245, 15, C.secondary); });

  const dtes = [...new Set(options.map(o => o.row?.dte ?? o.row?.today?.dte).filter(Boolean))];
  section("01", "市场结构", "MARKET STRUCTURE", 311, `Cboe 延迟期权快照 · DTE ${dtes.join(" / ") || "待确认"} · 接近阈值 0.2%`);
  options.forEach(({ symbol, row, s }, i) => {
    const x = 48 + i * 360, y = 338;
    const accent = s.gamma === "negative" ? C.red : s.gamma === "positive" ? C.green : C.muted;
    rect(x, y, 344, 354);
    rect(x + 1, y + 22, 3, 33, accent, "none", 1);
    text(symbol, x + 23, y + 39, 27, C.white, 700);
    text(s.gamma === "positive" ? "POSITIVE GEX" : s.gamma === "negative" ? "NEGATIVE GEX" : "GEX UNKNOWN", x + 321, y + 36, 12, accent, 600, 166, "end");
    text(num(market(symbol)?.today), x + 23, y + 87, 36, C.white, 600, 213);
    text(`${signed(market(symbol)?.change)}  收盘`, x + 25, y + 115, 17, ink(market(symbol)?.change), 500, 200);
    const values = safeHistory.map(r => r.market.metrics.find(m => m.symbol === symbol)?.today).filter(finite);
    if (values.length >= 2) {
      const lo = Math.min(...values), hi = Math.max(...values), spread = hi - lo || 1;
      const pts = values.map((v, j) => [x + 244 + 78 * j / (values.length - 1), y + 95 - 38 * (v - lo) / spread]);
      const d = pts.map(([px, py], j) => `${j ? "L" : "M"}${px.toFixed(1)} ${py.toFixed(1)}`).join(" ");
      out.push(`<path d="${d}" fill="none" stroke="${C.accent}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><circle cx="${pts.at(-1)![0]}" cy="${pts.at(-1)![1]}" r="3" fill="${C.accent}"/>`);
      text(`${values.length} 期收盘`, x + 321, y + 117, 12, C.muted, 400, 100, "end");
    }
    line(x + 22, y + 136, 300);
    [
      ["Gamma Flip", num(s.values.gamma_flip)], ["Put Wall", num(s.values.put_wall)],
      ["Call Wall", num(s.values.call_wall)],
      ["Net GEX", finite(s.values.net_gex) ? `${s.values.net_gex >= 0 ? "+" : "−"}$${num(Math.abs(s.values.net_gex) / 1e9)}B` : "—"],
    ].forEach(([k, v], j) => { text(k, x + 23, y + 165 + j * 34, 17, C.secondary); text(v, x + 321, y + 165 + j * 34, 19, j === 3 ? accent : C.white, j === 3 ? 650 : 500, 175, "end", true); });
    const w = pill(FLIP_LABEL[s.flip], x + 22, y + 286, s.flip === "below" ? C.red : s.flip === "unknown" ? C.muted : C.green, 143);
    pill(WALL_LABEL[s.wall], x + 32 + w, y + 286, C.accent, 161);
    const quote = row?.today?.as_of;
    text(`期权报价 ${quote?.slice(0, 10) === review.date ? quote.slice(11, 19) : quote?.replace("T", " ") ?? "待更新"} ET`, x + 23, y + 337, 12, C.muted, 400, 299);
  });
  rect(1488, 338, 384, 354, C.panel2, C.line);
  text("结构要点", 1512, 379, 23, C.white, 600);
  const above = options.filter(o => o.s.flip === "above").map(o => o.symbol);
  const below = options.filter(o => o.s.flip === "below").map(o => o.symbol);
  const nearCall = options.filter(o => ["near-call", "near-both"].includes(o.s.wall)).map(o => o.symbol);
  const bullets = [above.length ? `${above.join(" / ")} 位于 Flip 上方。` : "暂无可确认的 Flip 上方标的。", below.length ? `${below.join(" / ")} 位于 Flip 下方；GEX 正负单独判断。` : "暂无可确认的 Flip 下方标的。", nearCall.length ? `${nearCall.join(" / ")} 接近 Call Wall，跟踪关键位置。` : "本日未出现接近 Call Wall 的标的。"];
  bullets.forEach((s, i) => { text("•", 1512, 422 + i * 68, 20, i === 1 ? C.gold : C.accent); paragraph(s, 1532, 422 + i * 68, 311, 17, C.secondary, 2); });
  line(1512, 620, 336);
  paragraph("价格位置与 GEX 独立描述；墙位不等于必然支撑或阻力。", 1512, 650, 336, 16, C.muted, 2);

  section("02", "持仓与信号", "PORTFOLIO & SIGNAL", 742, "模型账户与信号分开展示 · 入场评分固定保留");
  rect(48, 770, 412, 322);
  text("模型现金账户", 72, 809, 22, C.white, 600, 10000, "start", false, 801);
  text("DAILY RETURN", 72, 835, 12, C.muted, 500);
  const accounts = ["2h", "4h"].map(tf => review.accounts.find(a => a.tf === tf));
  accounts.forEach((a, i) => {
    const x = 72 + 194 * i;
    text(`${i ? "4H" : "2H"} 账户`, x, 869, 19, C.secondary, 600);
    text(signed(a?.daily), x, 915, 36, ink(a?.daily), 600, 171);
    text("本月", x, 954, 16, C.muted); text(signed(a?.monthly), x + 167, 954, 19, ink(a?.monthly), 500, 108, "end");
    text("持仓", x, 986, 16, C.muted); text(`${a?.holdings ?? "—"} 只`, x + 167, 986, 19, C.white, 500, 110, "end");
    text("现金", x, 1018, 16, C.muted); text(`${num(a?.cashPct, 1)}%`, x + 167, 1018, 19, C.white, 500, 110, "end");
  });
  out.push(`<path d="M254 853V1026" stroke="${C.line}"/>`);
  line(72, 1042, 364);
  text(accounts.some(a => a?.monthly == null) ? "本月 — 表示缺少月初收益基准" : "日收益按相邻交易日净值计算", 72, 1073, 15, C.muted);

  rect(476, 770, 660, 322);
  text("持仓强度", 500, 809, 22, C.white, 600, 10000, "start", false, 801);
  text("今日 RPS · 前 5 个标的", 1112, 808, 15, C.muted, 400, 245, "end", false, 801);
  const holdCols = [500, 616, 750, 853, 1032];
  ["标的", "持仓周期", "RPS", "板块", "强度"].forEach((s, i) => text(s, holdCols[i], 848, 15, C.muted));
  line(500, 862, 612);
  const grouped = new Map<string, { symbol: string; tfs: Set<string>; rps: number | null; sector: string | null }>();
  for (const row of review.followup?.rows ?? []) {
    if (row.position !== "held") continue;
    const old = grouped.get(row.symbol);
    if (old) old.tfs.add(row.tf.toUpperCase());
    else grouped.set(row.symbol, { symbol: row.symbol, tfs: new Set([row.tf.toUpperCase()]), rps: row.rps, sector: row.sector?.name ?? null });
  }
  const holdings = [...grouped.values()].sort((a, b) => (b.rps ?? -1) - (a.rps ?? -1) || a.symbol.localeCompare(b.symbol)).slice(0, 5);
  holdings.forEach((row, i) => {
    const y = 892 + i * 34;
    text(row.symbol, holdCols[0], y, 21, C.white, 650);
    text([...row.tfs].sort().join(" / "), holdCols[1], y, 16, C.secondary);
    text(num(row.rps, 1), holdCols[2], y, 20, C.green, 500, 90, "start", true);
    text(row.sector ?? "未分类", holdCols[3], y, 17, row.sector ? C.secondary : C.muted, 400, 160);
    text(row.rps == null ? "待更新" : row.rps >= 80 ? "强势" : "观察", holdCols[4], y, 17, row.rps != null && row.rps >= 80 ? C.green : C.muted, 500);
  });
  line(500, 1042, 612);
  text(`共 ${grouped.size} 个持仓标的 · RPS ≥80 标记强势`, 500, 1073, 15, C.muted);

  rect(1152, 770, 720, 322);
  const signals = review.signals.filter(s => s.source === "live" && s.date === review.date && s.quality.complete).sort((a, b) => b.quality.points - a.quality.points);
  text("当日买点", 1176, 809, 22, C.white, 600, 10000, "start", false, 801);
  text(`${signals.length} 条完整评分 · ≥70 分：${signals.filter(s => s.quality.points >= 70).length}`, 1848, 808, 15, C.muted, 400, 348, "end", false, 801);
  const signalCols = [1176, 1266, 1340, 1440, 1550, 1668];
  ["标的", "周期", "入场分", "信号状态", "模型持仓", "较强因子"].forEach((s, i) => text(s, signalCols[i], 848, 15, C.muted));
  line(1176, 862, 672);
  const factorName: Record<string, string> = { "强度": "RPS", "位置": "位置", "量价压力": "CVD", "板块共振": "板块", "成交分布": "分布" };
  signals.slice(0, 4).forEach((s, i) => {
    const y = 897 + i * 42, f = review.followup?.rows.find(r => r.signalId === s.id);
    const exited = f?.signal === "exit-recorded";
    const factors = [...s.quality.dimensions].filter(d => finite(d.points) && d.max > 0).sort((a, b) => b.points! / b.max - a.points! / a.max).slice(0, 2).map(d => factorName[d.name] ?? d.name).join(" / ");
    text(s.symbol, signalCols[0], y, 20, C.white, 600);
    text(s.tf.toUpperCase(), signalCols[1], y, 17, C.secondary);
    text(num(s.quality.points, 1), signalCols[2], y, 22, s.quality.points >= 70 ? C.green : C.gold, 600);
    text(exited ? "已退出" : "新触发", signalCols[3], y, 17, exited ? C.muted : C.accent);
    text(f?.position === "held" ? "持有" : f?.position === "not-held" ? "未持有" : "待更新", signalCols[4], y, 17, f?.position === "held" ? C.green : C.secondary);
    text(factors, signalCols[5], y, 17, C.secondary, 400, 180);
  });
  line(1176, 1042, 672);
  text("较强因子按各维度得分率排序 · 总分非盈利概率", 1176, 1073, 15, C.muted);

  section("03", "下一交易日观察重点", "TOMORROW FOCUS", 1142, reconstructed ? "真实历史数据重算 · 不视为当时已发布的预测" : "固定规则筛选 · 按重要性排序");
  const events = review.tomorrow?.events.slice(0, 5) ?? [];
  const count = Math.max(1, events.length), eventWidth = (1824 - 16 * (count - 1)) / count;
  const domain: Record<string, string> = { accounts: "持仓变化", market: "市场参与度", sectors: "板块轮动", options: "期权结构", signals: "信号跟踪", macro: "宏观观察" };
  events.forEach((e, i) => {
    const x = 48 + i * (eventWidth + 16), y = 1170;
    const color = e.domain === "accounts" ? C.accent : e.title.includes("减弱") ? C.red : e.title.includes("改善") ? C.green : C.gold;
    rect(x, y, eventWidth, 188);
    rect(x + 1, y + 16, 3, 24, color, "none", 1);
    text(`${String(i + 1).padStart(2, "0")}  ${domain[e.domain] ?? e.domain}`, x + 20, y + 34, 15, color, 600);
    text(e.title, x + 20, y + 72, 22, C.white, 600, eventWidth - 40);
    const evidence = e.evidence.replace(/；今日相对 SPY /g, " · 当日相对 SPY ").replace(/ 个百分点/g, " pp");
    paragraph(evidence, x + 20, y + 109, eventWidth - 40, 16, C.secondary, 2);
    paragraph(e.focus, x + 20, y + 149, eventWidth - 40, 16, C.muted, 2);
  });
  if (!events.length) text("暂无达到筛选条件的新变化", 72, 1236, 24, C.secondary);
  line(48, 1380, 1824);
  out.push(reportWordmark("brand", 48, 1410, 16, C.accent));
  text("/  趋势自适应系统", 224, 1410, 14, C.muted);
  text("仅供信息参考，不构成投资建议", 960, 1410, 14, C.muted, 400, 620, "middle");
  const asOf = new Intl.DateTimeFormat("sv-SE", { timeZone: "America/New_York", dateStyle: "short", timeStyle: "short" }).format(new Date(review.builtAt));
  text(`复盘生成 ${asOf} ET · ${sample ? "样图" : "01 / 02"}`, 1872, 1410, 14, C.muted, 400, 620, "end");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><defs>${[...glyphDefs.values()].join("")}</defs>${out.join("\n")}</svg>`;
}
