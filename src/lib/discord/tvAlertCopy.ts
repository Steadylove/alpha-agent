import type { Timeframe } from "@/lib/backtest/engine";
import { SMALL_FUND_DEFAULT_CONFIG } from "@/lib/backtest/smallFundUniverse";
import { STRATEGY_NAME } from "./brand";
import type { DiscordPayload } from "./sendWebhook";

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
  rps?: number;
  footer?: string;
};

export function buildAlertView(p: AlertPayload, label: string, rps?: number): AlertView {
  if (p.event === "buy") {
    const stop = isNum(p.atr) && isNum(p.stopMult) ? p.price - p.stopMult * p.atr : undefined;
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
      rps,
    };
  }

  const won = isNum(p.pnl) ? p.pnl >= 0 : null;
  return {
    tone: won === null ? "sell" : won ? "take" : "stop",
    title: won === null ? "卖点" : won ? "止盈" : "止损",
    code: won === null ? "SELL" : won ? "TAKE" : "STOP",
    symbol: p.symbol,
    tfLabel: label,
    price: p.price,
    entry: isNum(p.entry) ? p.entry : undefined,
    pnl: isNum(p.pnl) ? p.pnl : undefined,
    footer: isNum(p.stop) ? `触发：收盘跌破生效止损 ${money(p.stop)}` : undefined,
  };
}

export function renderBuy(p: AlertPayload, label: string, rps: number): DiscordPayload {
  const fields = [
    { name: "信号价", value: `\`${money(p.price)}\``, inline: true },
    { name: "强度", value: strengthLabel(rps), inline: true },
  ];
  if (isNum(p.atr) && isNum(p.stopMult)) {
    const stop = p.price - p.stopMult * p.atr;
    fields.splice(1, 0, {
      name: "参考止损",
      value: `\`${money(stop)}\`\n${signed(((stop - p.price) / p.price) * 100)} · ${p.stopMult}×ATR`,
      inline: true,
    });
  }
  return {
    content: `🟢 **${STRATEGY_NAME} 买点 · ${p.symbol}** · ${label}`,
    embeds: [{ color: 0x22c55e, fields }],
  };
}

export function renderSell(p: AlertPayload, label: string): DiscordPayload {
  const won = isNum(p.pnl) ? p.pnl >= 0 : null;
  const head =
    won === null
      ? { icon: "🔴", title: "卖点", color: 0xef4444 }
      : won
        ? { icon: "💰", title: "止盈", color: 0x00897b }
        : { icon: "🛑", title: "止损", color: 0x546e7a };

  const fields = [{ name: "信号价", value: `\`${money(p.price)}\``, inline: true }];
  if (isNum(p.entry)) fields.push({ name: "开仓价", value: `\`${money(p.entry)}\``, inline: true });
  if (isNum(p.pnl)) fields.push({ name: "盈亏", value: `\`${signed(p.pnl)}\``, inline: true });

  return {
    content: `${head.icon} **${STRATEGY_NAME} ${head.title} · ${p.symbol}** · ${label}`,
    embeds: [
      {
        color: head.color,
        fields,
        ...(isNum(p.stop) ? { footer: { text: `触发：收盘跌破生效止损 ${money(p.stop)}` } } : {}),
      },
    ],
  };
}
