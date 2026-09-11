import type { Timeframe } from "@/lib/backtest/engine";
import { SMALL_FUND_DEFAULT_CONFIG } from "@/lib/backtest/smallFundUniverse";
import { formatFundRatio, type FundScore } from "@/lib/scoring/fundScore";
import { STRATEGY_NAME } from "./brand";
import type { DiscordPayload } from "./sendWebhook";
import { buyChartOf, sellChartOf, type SignalTradeChart } from "./signalTradeChart";
import { entryQualityOf, exitTitleOf, qualityPanel, signalReturnOf, tradeReviewOf, type AssessmentPanel, type EntryQuality, type ExitReason } from "@/lib/signals/assessment";

export function rpsMinOf(tf: Timeframe): number {
  if (tf === "4h") return 30;
  if (tf === "2h") return 0;
  if (tf === "1h") return 30;
  return SMALL_FUND_DEFAULT_CONFIG.rpsMin;
}

/** 与引擎入场闸门一致：回看未齐是 0，不能当过门。 */
export function buyPassesGate(rps: number | null, rpsMin: number): boolean {
  return rps != null && rps >= 1 && rps >= rpsMin;
}

/** 该股相对大池的分位，不是入场门槛。 */
export function strengthLabel(rps: number): string {
  return `强于 ${Math.round(rps)}%`;
}

/** 默认 4H 信号不展示周期标记，其他周期保留区分。 */
export function alertTimeframeSuffix(label: string): string {
  return label.toUpperCase() === "4H" ? "" : ` · ${label}`;
}

export type AlertPayload = {
  event: string;
  symbol: string;
  tf: string;
  kind: number;
  price: number;
  atr?: number;
  stopMult?: number;
  entry?: number;
  stop?: number;
  pnl?: number;
  /** TradingView K 线收盘时间（毫秒），供重复告警去重。 */
  barTime?: number;
  /** 这笔持仓实际开仓的 K 线开盘时间，毫秒。 */
  entryTime?: number;
  /** 参数签名 + 原始买点收盘时间用于精确关联，不按价格猜测交易。 */
  strategyKey?: string;
  entrySignalTime?: number;
  initialRisk?: number;
  highSinceEntry?: number;
  lowSinceEntry?: number;
  barsHeld?: number;
  exitReason?: ExitReason;
  target?: number;
  /** Pine 随买卖点携带的 K 线与 Vegas 通道快照，需校验后使用。 */
  chart?: unknown;
};

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const money = (v: number) => `$${v.toFixed(2)}`;
const signed = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;

export type AlertTone = "buy" | "take" | "stop" | "sell";

export type AlertView = {
  tone: AlertTone;
  title: string;
  code: string;
  symbol: string;
  tfLabel: string;
  price: number;
  stop?: number;
  stopPct?: number;
  stopMult?: number;
  entry?: number;
  pnl?: number;
  atr?: number;
  atrPct?: number;
  rps?: number;
  fund?: FundScore;
  footer?: string;
  chart?: SignalTradeChart;
  quality?: EntryQuality;
  assessment?: AssessmentPanel;
};

export type AlertCardField = {
  label: string;
  value: string;
  sub?: string;
  role: "price" | "stop" | "entry" | "pnl" | "atr" | "strength" | "fund";
};

function rankedRps(rps?: number): number | undefined {
  return rps != null && rps >= 1 ? rps : undefined;
}

function atrOf(p: AlertPayload): { atr: number; atrPct: number } | undefined {
  if (!isNum(p.atr) || p.atr <= 0 || !isNum(p.price) || p.price <= 0) return;
  return { atr: p.atr, atrPct: (p.atr / p.price) * 100 };
}

/** 波动按当前周期的 ATR/信号价描述；分档仅用于展示，不是历史分位或涨跌预测。 */
function volatilityField(view: AlertView): AlertCardField | undefined {
  if (!isNum(view.atr) || view.atr <= 0 || !isNum(view.atrPct) || view.atrPct <= 0) return;
  const pct = view.atrPct;
  return {
    label: "近期波动",
    value: pct < 1 ? "较小" : pct < 2 ? "适中" : pct < 4 ? "较大" : "很大",
    sub: pct < .01 ? "单根平均波幅不足 0.01%" : `单根平均波幅约 ${pct.toFixed(2)}%`,
    role: "atr",
  };
}

/** 卡片字段：强度与波动可同时出现，卖点不再用强度顶掉盈亏。 */
export function alertCardFields(view: AlertView): AlertCardField[] {
  const fields: AlertCardField[] = [{ label: "信号价", value: money(view.price), role: "price" }];
  if (view.stop != null) {
    fields.push({
      label: "参考止损",
      value: money(view.stop),
      sub:
        view.stopPct != null
          ? `距信号价 ${signed(view.stopPct)}`
          : undefined,
      role: "stop",
    });
  } else if (view.entry != null) {
    fields.push({ label: "开仓价", value: money(view.entry), role: "entry" });
  }
  if (view.pnl != null) {
    fields.push({ label: "信号浮盈亏", value: signed(view.pnl), role: "pnl" });
  }
  const volatility = volatilityField(view);
  if (volatility) fields.push(volatility);
  if (view.rps != null) {
    fields.push({ label: "强度", value: strengthLabel(view.rps), role: "strength" });
  }
  if (view.fund?.usable) {
    fields.push({
      label: "基本面",
      value: view.fund.tier ? `${view.fund.tier} ${view.fund.total}` : String(view.fund.total),
      sub: `${view.fund.filled}/6 维`,
      role: "fund",
    });
  }
  return fields;
}

export function fundDimLabels(fund: FundScore): string[] {
  return fund.dims.map((dim) =>
    `${dim.label} ${dim.value == null ? "—" : formatFundRatio(dim.id, dim.value)} ${dim.value == null ? "缺" : dim.points}`,
  );
}

export function buildAlertView(p: AlertPayload, label: string, rps?: number, fund?: FundScore): AlertView {
  const atr = atrOf(p);
  if (p.event === "buy") {
    const stop = isNum(p.atr) && isNum(p.stopMult) ? p.price - p.stopMult * p.atr : undefined;
    const quality = entryQualityOf(p, rps, fund);
    return {
      tone: "buy",
      title: "买点",
      code: "BUY",
      symbol: p.symbol,
      tfLabel: label,
      price: p.price,
      stop,
      stopPct: stop != null ? ((stop - p.price) / p.price) * 100 : undefined,
      stopMult: isNum(p.stopMult) ? p.stopMult : undefined,
      ...atr,
      rps: rankedRps(rps),
      fund: fund?.usable ? fund : undefined,
      chart: buyChartOf(p.chart, p.barTime, p.price),
      quality,
      assessment: qualityPanel(quality),
    };
  }

  const pnl = signalReturnOf(p);
  const won = pnl != null ? pnl >= 0 : null;
  return {
    tone: won === null ? "sell" : won ? "take" : "stop",
    title: exitTitleOf(p),
    code: won === null ? "SELL" : won ? "TAKE" : "STOP",
    symbol: p.symbol,
    tfLabel: label,
    price: p.price,
    entry: isNum(p.entry) ? p.entry : undefined,
    pnl,
    ...atr,
    rps: rankedRps(rps),
    fund: fund?.usable ? fund : undefined,
    chart: sellChartOf(p.chart, p.entryTime, p.entry, p.barTime, p.price),
    footer: p.exitReason === "target" && isNum(p.target) && p.price >= p.target ? `触发：收盘达到目标 ${money(p.target)}` :
      isNum(p.stop) && p.price < p.stop ? `触发：收盘跌破生效止损 ${money(p.stop)}` : undefined,
    assessment: tradeReviewOf(p),
  };
}

function embedFieldsOf(view: AlertView): { name: string; value: string; inline: true }[] {
  return alertCardFields(view).map((field) => ({
    name: field.label,
    value: field.sub ? `\`${field.value}\`\n${field.sub}` : `\`${field.value}\``,
    inline: true,
  }));
}

export function renderBuy(p: AlertPayload, label: string, rps: number, fund?: FundScore): DiscordPayload {
  return {
    content: `🟢 **${STRATEGY_NAME} 买点 · ${p.symbol}**${alertTimeframeSuffix(label)}`,
    embeds: [{ color: 0x22c55e, fields: embedFieldsOf(buildAlertView(p, label, rps, fund)) }],
  };
}

export function renderSell(p: AlertPayload, label: string, rps?: number, fund?: FundScore): DiscordPayload {
  const view = buildAlertView(p, label, rps, fund);
  const head =
    view.tone === "take"
      ? { icon: "💰", color: 0x00897b }
      : view.tone === "stop"
        ? { icon: "🛑", color: 0x546e7a }
        : { icon: "🔴", color: 0xef4444 };

  return {
    content: `${head.icon} **${STRATEGY_NAME} ${view.title} · ${p.symbol}**${alertTimeframeSuffix(label)}`,
    embeds: [
      {
        color: head.color,
        fields: embedFieldsOf(view),
        ...(view.footer ? { footer: { text: view.footer } } : {}),
      },
    ],
  };
}
