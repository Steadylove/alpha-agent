/** Pine 信号快照：[开盘时间, 收盘时间, O, H, L, C, EMA166, EMA169, EMA576, EMA676]。 */
export type SignalCandle = [number, number, number, number, number, number, number | null, number | null, number | null, number | null];
export type SignalTradeChart = {
  bars: SignalCandle[];
  stride: number;
  signalTime: number;
  signalPrice: number;
} & ({ event: "buy" } | {
  event: "sell";
  entryTime: number;
  entryPrice: number;
});

const positive = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n > 0;
const timestamp = (n: unknown): n is number => positive(n) && Number.isSafeInteger(n) && n <= 8.64e15;

/** 买卖点共用行情校验，不允许用未来或过期 K 线标记当前信号。 */
function chartSnapshotOf(raw: unknown, signalTime: unknown, signalPrice: unknown) {
  if (!raw || typeof raw !== "object" || !timestamp(signalTime) || !positive(signalPrice)) return;
  const p = raw as Record<string, unknown>;
  if (p.version !== 1 || !Number.isInteger(p.stride) || Number(p.stride) < 1 || Number(p.stride) > 2000 || !Array.isArray(p.bars) || p.bars.length < 2 || p.bars.length > 120) return;
  let previousEnd = 0;
  for (const row of p.bars) {
    if (!Array.isArray(row) || row.length !== 10) return;
    const [start, end, open, high, low, close, ...emas] = row;
    if (!timestamp(start) || !timestamp(end) || end <= start || start < previousEnd || end > signalTime ||
      ![open, high, low, close].every(positive) || low > Math.min(open, close) || high < Math.max(open, close) ||
      !emas.every((v) => v === null || positive(v))) return;
    previousEnd = end;
  }
  const bars = p.bars as SignalCandle[];
  if (bars.at(-1)![1] !== signalTime || Math.abs(bars.at(-1)![5] - signalPrice) > Math.max(0.0002, signalPrice * 0.00001)) return;
  return { bars, stride: Number(p.stride), signalTime, signalPrice };
}

/** 买点定位在刚确认的末根收盘，不伪造下一根开盘成交或未来卖点。 */
export function buyChartOf(raw: unknown, signalTime: unknown, signalPrice: unknown): SignalTradeChart | undefined {
  const snapshot = chartSnapshotOf(raw, signalTime, signalPrice);
  return snapshot ? { ...snapshot, event: "buy" } : undefined;
}

/** 不从相同价格猜买入日期。无效附图不阻断卖点。 */
export function sellChartOf(raw: unknown, entryTime: unknown, entryPrice: unknown, sellTime: unknown, sellPrice: unknown): SignalTradeChart | undefined {
  const snapshot = chartSnapshotOf(raw, sellTime, sellPrice);
  if (!snapshot || !timestamp(entryTime) || entryTime > snapshot.signalTime || !positive(entryPrice)) return;
  const { bars } = snapshot;
  if (entryTime >= bars[0][0] && !bars.some((r) => entryTime >= r[0] && entryTime < r[1])) return;
  // 告警含买入时刻但区间没有对应 K 线时，只显示价格参考，不伪造买点。
  return { ...snapshot, event: "sell", entryTime, entryPrice };
}

export const TRADE_CHART_WIDTH = 880;
export const TRADE_CHART_HEIGHT = 408;
export const TRADE_CHART_COLORS = { fast: "#77C8D4", slow: "#B0A6D8", buy: "#65DBAF", sell: "#EBC47F", stop: "#F093A0" };
const fmt = (n: number) => n.toFixed(2);
const dateLabel = (t: number) => new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", month: "2-digit", day: "2-digit" }).format(t);

export function signalTradeChartLayout(chart: SignalTradeChart) {
  const { bars } = chart, left = 8, top = 26, width = TRADE_CHART_WIDTH - 85, height = 328;
  const values = bars.flatMap((r) => [r[3], r[4], ...r.slice(6).filter((v): v is number => v != null)]);
  values.push(chart.signalPrice);
  if (chart.event === "sell") values.push(chart.entryPrice);
  const min = Math.min(...values), max = Math.max(...values), padding = Math.max((max - min) * .16, max * .003);
  const bottom = min - padding, span = max - min + padding * 2;
  // 右侧只留价签空间，不补画未来 K 线；末根标记可用短横线连接。
  const dataWidth = width - 174;
  const x = (i: number) => left + (i + .5) / bars.length * dataWidth;
  const y = (p: number) => top + height - (p - bottom) / span * height;
  const entryIndex = chart.event === "sell" ? bars.findIndex((r) => chart.entryTime >= r[0] && chart.entryTime < r[1]) : -1;
  const ticks = Array.from({ length: 5 }, (_, i) => ({ y: top + i * height / 4, price: fmt(bottom + span * (1 - i / 4)) }));
  const dateIndices = [...new Set([0, Math.floor((bars.length - 1) / 2), bars.length - 1])];
  const dates = dateIndices.map((i) => ({ x: x(i), label: dateLabel(bars[i][0]) }));
  return { left, top, width, dataWidth, height, x, y, entryIndex, ticks, dates };
}

type ChartCallout = {
  x: number; y: number; width: number; height: number; text: string; fill: string;
  side: "above" | "below" | "right";
  point?: { x: number; y: number };
};

/** 从多个临近位置选遮挡最少的价签；兼顾 K 线、Vegas 及另一枚价签。 */
export function signalTradeChartCallouts(chart: SignalTradeChart): ChartCallout[] {
  const { x, y, left, width, top, height, entryIndex } = signalTradeChartLayout(chart);
  const last = chart.bars.length - 1;
  const occupied: ChartCallout[] = [];
  const callout = (index: number, price: number, text: string, fill: string, side: ChartCallout["side"]): ChartCallout => {
    const boxWidth = text.length > 13 ? 200 : 158, boxHeight = 34;
    const px = index < 0 ? left : x(index), py = y(price);
    const candidates: { x: number; y: number; side: ChartCallout["side"]; score: number }[] = [];
    if (index === last && px + 12 + boxWidth <= left + width) {
      const by = Math.max(3, Math.min(top + height - boxHeight + 18, py - boxHeight / 2));
      const conflict = occupied.some((c) => px + 12 < c.x + c.width + 8 && by < c.y + c.height + 8 && by + boxHeight + 8 > c.y);
      candidates.push({ x: px + 12, y: by, side: "right", score: conflict ? 100000 : 0 });
    }
    for (const offset of [32, 66, 100]) for (const direction of [side, side === "below" ? "above" : "below"] as const) {
      for (const shift of [-boxWidth / 2, -boxWidth + 12, 12]) {
        const bx = Math.max(left, Math.min(left + width - boxWidth, px + shift));
        const by = Math.max(3, Math.min(top + height - boxHeight + 18, py + (direction === "below" ? offset : -offset - boxHeight)));
        let score = Math.abs(by + boxHeight / 2 - py) * .2 + Math.abs(bx + boxWidth / 2 - px) * .12;
        if (direction !== side) score += 8;
        for (const [i, bar] of chart.bars.entries()) {
          if (x(i) < bx - 7 || x(i) > bx + boxWidth + 7) continue;
          if (y(bar[3]) <= by + boxHeight + 7 && y(bar[4]) >= by - 7) score += 500;
          for (const ema of bar.slice(6)) if (ema != null && y(ema) >= by - 7 && y(ema) <= by + boxHeight + 7) score += 50;
        }
        for (const other of occupied) if (bx < other.x + other.width + 8 && bx + boxWidth + 8 > other.x && by < other.y + other.height + 8 && by + boxHeight + 8 > other.y) score += 100000;
        candidates.push({ x: bx, y: by, side: direction, score });
      }
    }
    const chosen = candidates.sort((a, b) => a.score - b.score)[0];
    const result: ChartCallout = { ...chosen, width: boxWidth, height: boxHeight, text, fill,
      point: index < 0 ? undefined : { x: px, y: py } };
    occupied.push(result);
    return result;
  };
  if (chart.event === "buy") return [callout(last, chart.signalPrice, `买点 $${fmt(chart.signalPrice)}`, TRADE_CHART_COLORS.buy, "below")];
  const buy = callout(entryIndex, chart.entryPrice, `${entryIndex < 0 ? "区间外买入" : "买入"} $${fmt(chart.entryPrice)}`, TRADE_CHART_COLORS.buy, "below");
  const sellColor = chart.signalPrice < chart.entryPrice ? TRADE_CHART_COLORS.stop : TRADE_CHART_COLORS.sell;
  const sell = callout(last, chart.signalPrice, `卖点 $${fmt(chart.signalPrice)}`, sellColor, "above");
  return [buy, sell];
}

type ChartLabel = {
  x: number; y: number; width: number; text: string; color: string;
  height?: number; fontSize?: number; fontWeight?: 400 | 700; align?: "center";
};

/** 共用文字坐标，生产 OG 与本地 SVG 预览保持一致。 */
export function signalTradeChartLabels(chart: SignalTradeChart): ChartLabel[] {
  const { ticks, dates } = signalTradeChartLayout(chart);
  return [
    ...ticks.map((t) => ({ x: 818, y: t.y - 9, width: 62, text: t.price, color: "#A2B2BF", fontSize: 13 })),
    ...dates.map((d) => ({ x: Math.max(0, Math.min(752, d.x - 20)), y: 389, width: 62, text: d.label, color: "#8C9EAE", fontSize: 13 })),
    ...signalTradeChartCallouts(chart).map((c): ChartLabel => ({
      x: c.x, y: c.y, width: c.width, height: c.height, text: c.text,
      color: "#F0F4F7", fontSize: 15, fontWeight: 700, align: "center",
    })),
  ];
}

export function signalTradeChartNote(chart: SignalTradeChart): string {
  return `${chart.stride > 1 ? `每根合并 ${chart.stride} 根 · ` : ""}时间：美东 · ${chart.event === "buy" ? "买点" : "卖点"}为收盘触发价${chart.event === "sell" && signalTradeChartLayout(chart).entryIndex < 0 ? " · 买入早于图示区间" : ""}`;
}

/** 纯图形 SVG；文字由外层渲染器绘制，保证服务器端中文字体一致。 */
export function signalTradeChartSvg(chart: SignalTradeChart, pixelScale = 1): string {
  const { bars } = chart;
  const { left, top, width, dataWidth, height, x, y, entryIndex, ticks } = signalTradeChartLayout(chart);
  const f = (v: number) => v.toFixed(2);
  const callouts = signalTradeChartCallouts(chart);
  const parts = [`<svg xmlns="http://www.w3.org/2000/svg" width="${TRADE_CHART_WIDTH * pixelScale}" height="${TRADE_CHART_HEIGHT * pixelScale}" viewBox="0 0 ${TRADE_CHART_WIDTH} ${TRADE_CHART_HEIGHT}">`];
  for (const tick of ticks) parts.push(`<path d="M${left},${f(tick.y)}H${left+width}" stroke="#26333D" stroke-width="0.8"/>`);
  for (const c of callouts) if (c.point) {
    parts.push(`<rect x="${f(c.point.x - 3)}" y="${top}" width="6" height="${height}" fill="${c.fill}" fill-opacity="0.06"/>`);
  }
  for (const [a, b, color] of [[6,7,TRADE_CHART_COLORS.fast],[8,9,TRADE_CHART_COLORS.slow]] as const) {
    // 分段，EMA 预热不足的空值不能被接成一条假通道。
    let segment: number[] = [];
    const flush = () => {
      if (!segment.length) return;
      const edge = (indices: number[], col: number) => indices.map((i) => `${f(x(i))},${f(y(bars[i][col]!))}`).join(" ");
      parts.push(`<polygon points="${edge(segment,a)} ${edge([...segment].reverse(),b)}" fill="${color}" fill-opacity="0.09"/>`);
      for(const col of [a,b]) parts.push(`<polyline points="${edge(segment,col)}" fill="none" stroke="${color}" stroke-width="1.25" stroke-linejoin="round"/>`);
      segment=[];
    };
    bars.forEach((r,i)=>{if(r[a]==null||r[b]==null)flush();else segment.push(i);}); flush();
  }
  const bodyWidth = Math.min(8, dataWidth/bars.length*.64);
  bars.forEach((r,i)=>{
    const color=r[5]>=r[2]?"#54CAA1":"#E18493";
    parts.push(`<path d="M${f(x(i))},${f(y(r[3]))}V${f(y(r[4]))}" stroke="${color}" stroke-width="1.1"/>`);
    parts.push(`<rect x="${f(x(i)-bodyWidth/2)}" y="${f(Math.min(y(r[2]),y(r[5])))}" width="${f(bodyWidth)}" height="${f(Math.max(1,Math.abs(y(r[2])-y(r[5]))))}" fill="${color}"/>`);
  });
  if(chart.event === "sell") {
    const buyY=y(chart.entryPrice), sellY=y(chart.signalPrice), sellX=x(bars.length-1);
    if(entryIndex>=0) {
      parts.push(`<path d="M${f(x(entryIndex))},${f(buyY)}L${f(sellX)},${f(sellY)}" stroke="#A2B2BF" stroke-dasharray="3 6" opacity="0.42"/>`);
    } else {
      parts.push(`<path d="M${left},${f(buyY)}H${left+width}" stroke="${TRADE_CHART_COLORS.buy}" stroke-dasharray="3 4" opacity="0.5"/>`);
    }
  }
  for (const c of callouts) {
    if (c.point) {
      const attachX = c.side === "right" ? c.x : Math.max(c.x + 12, Math.min(c.x + c.width - 12, c.point.x));
      const attachY = c.side === "right" ? c.y + c.height / 2 : c.side === "below" ? c.y : c.y + c.height;
      parts.push(`<path d="M${f(c.point.x)},${f(c.point.y)}L${f(attachX)},${f(attachY)}" stroke="${c.fill}" stroke-width="1.3"/>`);
      parts.push(`<circle cx="${f(c.point.x)}" cy="${f(c.point.y)}" r="8" fill="${c.fill}" fill-opacity="0.13"/>`);
      parts.push(`<circle cx="${f(c.point.x)}" cy="${f(c.point.y)}" r="4.5" fill="${c.fill}" stroke="#0B1117" stroke-width="2"/>`);
    }
    parts.push(`<rect x="${f(c.x)}" y="${f(c.y)}" width="${c.width}" height="${c.height}" rx="5" fill="#17232D" stroke="${c.fill}" stroke-width="1"/>`);
    parts.push(`<rect x="${f(c.x + 5)}" y="${f(c.y + 9)}" width="3" height="16" rx="1" fill="${c.fill}"/>`);
  }
  parts.push("</svg>");
  return parts.join("");
}
