/**
 * TradingView 告警中转：补上截面 RPS 闸门，再转发 Discord。
 *
 * Pine 只算得出单标的自足的信号（一买/二买 + RSI + Vegas），
 * `rps >= rpsMin` 要把当日全池 197 只一起排名，单脚本 40 个 request.*() 的
 * 上限决定了它在 TradingView 上无解。这里补的就是那一刀，用的是与回测
 * 同一份 `getPreparedUniverse`，口径不会漂。
 *
 * 闸门只标注不拦截：不达标的买点照样推，但标题与 RPS 那一格都会写明未达标，
 * 免得「没收到消息」和「消息没发出去」两种情况在频道里长得一样。
 *
 * 卖点不过闸门：RPS 是入场闸门，持仓该走就得走。何况持仓状态机整个在
 * Pine 里，本接口无状态，不知道任何一笔持仓的存在。
 *
 * 本接口不做鉴权，是明知代价后的选择，不是漏掉了：任何人 POST 一段合法
 * JSON 都能让频道收到一条伪造的买卖点。挡不住扫描器的话就把 token 校验加
 * 回来（TV 的 webhook 不能自定义请求头，只能走 query）。
 */

import { NextResponse } from "next/server";

import type { Timeframe } from "@/lib/backtest/engine";
import { getPreparedUniverse } from "@/lib/backtest/load";
import {
  SMALL_FUND_4H_DEFAULT_CONFIG,
  SMALL_FUND_DEFAULT_CONFIG,
} from "@/lib/backtest/smallFundUniverse";
import { postDiscordPayload, type DiscordPayload } from "@/lib/discord/sendWebhook";

export const maxDuration = 60;

/**
 * 只有这两档有离线 RPS 面板。别的周期照样转发，但闸门会标成「无面板」——
 * 周期限制是从 Pine 那边去掉的，接口跟着放开，不然 1H 的信号会直接 400 掉。
 */
const RPS_PANELS: Record<string, { tf: Timeframe; rpsMin: number }> = {
  D: { tf: "1d", rpsMin: SMALL_FUND_DEFAULT_CONFIG.rpsMin },
  "240": { tf: "4h", rpsMin: SMALL_FUND_4H_DEFAULT_CONFIG.rpsMin },
};

/** TV 的 timeframe.period 是 "D"/"W"/"M" 或纯分钟数，转成人看的写法。 */
function tfLabel(period: string): string {
  const mins = Number(period);
  if (Number.isFinite(mins) && mins > 0) {
    return mins % 60 === 0 ? `${mins / 60}H` : `${mins}m`;
  }
  return period === "D" ? "日线" : period === "W" ? "周线" : period === "M" ? "月线" : period;
}

const KIND_LABEL: Record<number, string> = { 1: "❤️ 一买", 2: "⭐️ 二买" };

type Payload = {
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
};

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function parsePayload(raw: unknown): Payload | null {
  if (typeof raw !== "object" || raw === null) return null;
  const p = raw as Record<string, unknown>;
  if (p.event !== "buy" && p.event !== "sell") return null;
  if (typeof p.symbol !== "string" || !p.symbol) return null;
  if (typeof p.tf !== "string") return null;
  if (!isNum(p.price)) return null;
  return p as unknown as Payload;
}

const money = (v: number) => `$${v.toFixed(2)}`;
const signed = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;

/**
 * 面板最后一根的截面分位。
 *
 * 取最后一根而非「告警当日」：面板靠离线抓取，通常落后 TV 几天。
 * 分位本身走 21/63/126/252 根的加权动量，几天的滞后不改变量级，
 * 但滞后多少要让人看得见，所以把日期一起带出去。
 */
async function latestRps(
  symbol: string,
  tf: Timeframe,
): Promise<{ rps: number; asOf: string } | null> {
  const universe = await getPreparedUniverse("SMALLFUND", tf);
  const sym = universe.symbols.find((s) => s.ticker === symbol);
  if (!sym) return null;

  const last = sym.rps.length - 1;
  if (last < 0) return null;

  // 0 表示当日未进入截面（回看未齐），与「不在池里」同等对待
  const rps = sym.rps[last];
  if (rps < 1) return null;

  return { rps, asOf: universe.axis[sym.axisIndex[last]] };
}

/**
 * 消息用 embed 而不是纯文本：左侧色条能在刷屏的频道里一眼分出闸门三态，
 * 三个 inline field 会排成一行，数字比 `键：值` 的纯文本好扫。
 *
 * content 那一行不是冗余：只发 embed 的话，手机推送弹出来是空的，
 * 锁屏上得能看见是哪只票的什么信号。
 */

/** 闸门三态：查到且达标、查到但不达标、查不到。三者在频道里要一眼可分。 */
type GateState = "pass" | "reject" | "unknown";
type Gate = { state: GateState; field: string; note: string | null };

const GATE_STYLE: Record<GateState, { icon: string; title: string; color: number }> = {
  pass: { icon: "🟢", title: "买点", color: 0x22c55e },
  reject: { icon: "⚪", title: "买点（RPS 未达标）", color: 0x64748b },
  unknown: { icon: "🟡", title: "买点（RPS 未知）", color: 0xf59e0b },
};

function renderBuy(p: Payload, label: string, gate: Gate): DiscordPayload {
  const style = GATE_STYLE[gate.state];
  const kind = KIND_LABEL[p.kind] ?? "买点";
  const fields = [{ name: "信号价", value: `\`${money(p.price)}\``, inline: true }];

  if (isNum(p.atr) && isNum(p.stopMult)) {
    const stop = p.price - p.stopMult * p.atr;
    fields.push({
      name: "参考止损",
      value: `\`${money(stop)}\`\n${signed(((stop - p.price) / p.price) * 100)} · ${p.stopMult}×ATR`,
      inline: true,
    });
  }
  fields.push({ name: "RPS", value: gate.field, inline: true });

  return {
    content: `${style.icon} **${style.title} · ${p.symbol}** ${kind} · ${label}`,
    embeds: [{ color: style.color, fields, ...(gate.note ? { footer: { text: gate.note } } : {}) }],
  };
}

function renderSell(p: Payload, label: string): DiscordPayload {
  // 触发机制只有一个（收盘跌破生效止损），叫止盈还是止损看这一笔的结果
  const won = isNum(p.pnl) ? p.pnl >= 0 : null;
  const head = won === null ? { icon: "🔴", title: "卖点", color: 0xef4444 }
    : won ? { icon: "💰", title: "止盈", color: 0x00897b }
    : { icon: "🛑", title: "止损", color: 0x546e7a };

  const fields = [{ name: "信号价", value: `\`${money(p.price)}\``, inline: true }];
  if (isNum(p.entry)) {
    fields.push({ name: "开仓价", value: `\`${money(p.entry)}\``, inline: true });
  }
  if (isNum(p.pnl)) {
    fields.push({ name: "盈亏", value: `\`${signed(p.pnl)}\``, inline: true });
  }

  const held = KIND_LABEL[p.kind] ? `${KIND_LABEL[p.kind]} 平仓` : "平仓";
  return {
    content: `${head.icon} **${head.title} · ${p.symbol}** ${held} · ${label}`,
    embeds: [
      {
        color: head.color,
        fields,
        ...(isNum(p.stop) ? { footer: { text: `触发：收盘跌破生效止损 ${money(p.stop)}` } } : {}),
      },
    ],
  };
}

export async function POST(request: Request) {
  // 想分频道就配 DISCORD_SIGNAL_WEBHOOK_URL，不配就跟每日简报挤一个频道
  const webhookUrl = process.env.DISCORD_SIGNAL_WEBHOOK_URL || process.env.DISCORD_WEBHOOK_URL;
  if (!webhookUrl) {
    return NextResponse.json(
      { error: "Neither DISCORD_SIGNAL_WEBHOOK_URL nor DISCORD_WEBHOOK_URL is configured." },
      { status: 503 },
    );
  }

  // TV 只在正文是合法 JSON 时才带 application/json，统一按文本读再自己解
  let payload: Payload | null = null;
  try {
    payload = parsePayload(JSON.parse(await request.text()));
  } catch {
    payload = null;
  }
  if (!payload) {
    return NextResponse.json({ error: "Malformed alert payload." }, { status: 400 });
  }

  const label = tfLabel(payload.tf);
  const panel = RPS_PANELS[payload.tf] ?? null;

  if (payload.event === "sell") {
    await postDiscordPayload(webhookUrl, renderSell(payload, label));
    return NextResponse.json({ ok: true, forwarded: true });
  }

  let found: { rps: number; asOf: string } | null = null;
  let lookupError: string | null = null;
  if (panel) {
    try {
      found = await latestRps(payload.symbol, panel.tf);
    } catch (error) {
      lookupError = error instanceof Error ? error.message : String(error);
    }
  }

  let gate: Gate;
  if (!panel) {
    gate = { state: "unknown", field: `\`—\`\n${label} 无 RPS 面板`, note: null };
  } else if (!found) {
    const why = lookupError ? "面板读取失败" : "不在 Small Fund 池";
    gate = { state: "unknown", field: `\`—\`\n${why}`, note: null };
  } else if (found.rps < panel.rpsMin) {
    // 带一位小数：39.8 取整成 40 会让「RPS 40 < 40」看着像 bug
    gate = {
      state: "reject",
      field: `\`${found.rps.toFixed(1)}\`\n< ${panel.rpsMin} 未达标`,
      note: `RPS 面板截至 ${found.asOf}`,
    };
  } else {
    gate = {
      state: "pass",
      field: `\`${found.rps.toFixed(0)}\`\n≥ ${panel.rpsMin} 通过`,
      note: `RPS 面板截至 ${found.asOf}`,
    };
  }

  await postDiscordPayload(webhookUrl, renderBuy(payload, label, gate));
  return NextResponse.json({
    ok: true,
    forwarded: true,
    gate: gate.state,
    rps: found?.rps ?? null,
    lookupError,
  });
}
