import { createHash } from "node:crypto";
import { z } from "zod";

const time = z.number().int().min(946684800000).max(4102444800000);
const price = z.number().positive().max(1_000_000);
const measurements = z.record(z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,39}$/), z.union([z.number().finite(), z.boolean(), z.null()]));
export const intradaySignalSchema = z.object({
  protocol: z.literal("intraday-v1"),
  strategy: z.literal("resonance-long"),
  scriptVersion: z.string().regex(/^[\w.-]{1,40}$/),
  strategyKey: z.string().min(1).max(1024),
  symbol: z.string().regex(/^[A-Z0-9_]{1,20}:[A-Z0-9._-]{1,24}$/),
  tf: z.literal("1"),
  event: z.enum(["watch", "entry", "partial", "exit", "stop"]),
  reason: z.string().regex(/^[a-z0-9_]{1,80}$/),
  barTime: time,
  signalTime: time,
  entrySignalTime: time.nullable(),
  price,
  entryPrice: price.nullable(),
  stop: price.nullable(),
  metrics: measurements.refine(v => Object.keys(v).length <= 48),
  parameters: z.record(z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,39}$/), z.union([z.number().finite(), z.boolean(), z.string().max(80)]))
    .refine(v => Object.keys(v).length <= 40),
}).strict().superRefine((p, ctx) => {
  const invalid = (message: string) => ctx.addIssue({ code: "custom", message });
  if (p.barTime > p.signalTime || p.signalTime - p.barTime > 120_000) invalid("signal must belong to its one-minute bar");
  if (p.event !== "stop" && p.signalTime !== p.barTime + 60_000) invalid("indicator signals require a confirmed one-minute close");
  if (p.event === "watch") {
    if (p.entrySignalTime !== null || p.entryPrice !== null) invalid("watch is not an entry");
  } else if (p.entrySignalTime === null || p.entryPrice === null || p.stop === null || p.stop >= p.entryPrice || p.entrySignalTime > p.signalTime) {
    invalid("missing or invalid long trade reference");
  }
  if (p.event === "entry" && (p.entrySignalTime !== p.signalTime || p.entryPrice !== p.price)) invalid("entry reference mismatch");
});
export type IntradaySignal = z.infer<typeof intradaySignalSchema>;
export const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
// Identity excludes price/metrics: re-delivery cannot rewrite the first observation.
export const signalId = (p: IntradaySignal) => digest([p.strategy, p.scriptVersion, p.strategyKey, p.symbol, p.tf, p.event, p.barTime, p.entrySignalTime]);
export const tradeId = (p: IntradaySignal) => p.entrySignalTime === null ? null : digest([p.strategy, p.scriptVersion, p.strategyKey, p.symbol, p.tf, p.entrySignalTime]);
export function sessionDate(timestamp: number): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(timestamp);
}
export function easternTime(timestamp: number): string {
  return `${sessionDate(timestamp)} ${new Intl.DateTimeFormat("en-GB", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).format(timestamp)} ET`;
}
const names = { watch: "关注", entry: "入场信号", partial: "减仓信号", exit: "出场信号", stop: "止损信号" };
const reasons: Record<string, string> = {
  premium_resonance: "指标1 BUY + 近3根超卖共振（优质买点）", pivot_resonance: "指标1 BUY + 近3根能量共振",
  resonance_reduce: "动能转弱，减仓信号", resonance_top: "顶部区域，逃顶信号",
  stop_touch: "触及入场时锁定的止损",
  session_end: "盘前结束", session_gap: "会话中断后恢复，记录模型出场",
};
export function signalMessage(p: IntradaySignal, id: string): string {
  const metric = (key: string, suffix = "") => typeof p.metrics[key] === "number" ? `${(p.metrics[key] as number).toFixed(2)}${suffix}` : "未知";
  return [
    `TREND ADAPTIVE · ${names[p.event]}`, `${p.symbol} · 1m · 纯多头共振`,
    `信号价 $${p.price.toFixed(4)}${p.stop === null ? "" : ` · 锁定止损 $${p.stop.toFixed(4)}`}`,
    ...(p.event !== "entry" && p.entryPrice !== null ? [`入场信号价 $${p.entryPrice.toFixed(4)} · 信号价变化 ${((p.price / p.entryPrice - 1) * 100).toFixed(2)}%`] : []),
    `涨幅 ${metric("gainPct", "%")} · 当日累计量/50日均量 ${metric("rvol", "x")}`,
    `原因：${reasons[p.reason] ?? p.reason}`, "新闻催化：未核验",
    easternTime(p.signalTime), `策略 ${p.scriptVersion} · 信号 ${id.slice(0, 12)}`,
    "信号价不代表成交；仅供信息参考，不构成投资建议",
  ].join("\n");
}
