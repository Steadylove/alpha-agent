/**
 * TradingView 告警中转：补上截面 RPS 闸门，再转发 Discord。
 *
 * Pine 只算得出单标的自足的信号（一买/二买 + RSI + Vegas），
 * `rps >= rpsMin` 要把当日全池 197 只一起排名，单脚本 40 个 request.*() 的
 * 上限决定了它在 TradingView 上无解。这里补的就是那一刀，用的是与回测
 * 同一份 `getPreparedUniverse`，口径不会漂。
 *
 * 闸门只标注不拦截：不达标的买点照样推，但标题与末行都会写明未达标，
 * 免得「没收到消息」和「消息没发出去」两种情况在频道里长得一样。
 *
 * 卖点不过闸门：RPS 是入场闸门，持仓该走就得走。何况持仓状态机整个在
 * Pine 里，本接口无状态，不知道任何一笔持仓的存在。
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

/** TV 的 timeframe.period 原样送来，只认脚本支持的这两档。 */
const TIMEFRAMES: Record<string, { tf: Timeframe; label: string; rpsMin: number }> = {
  D: { tf: "1d", label: "日线", rpsMin: SMALL_FUND_DEFAULT_CONFIG.rpsMin },
  "240": { tf: "4h", label: "4H", rpsMin: SMALL_FUND_4H_DEFAULT_CONFIG.rpsMin },
};

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
  const token = process.env.TV_WEBHOOK_TOKEN;
  if (!token) {
    return NextResponse.json({ error: "TV_WEBHOOK_TOKEN is not configured." }, { status: 503 });
  }
  // TV 的 webhook 不能自定义请求头，令牌只能走 query
  if (new URL(request.url).searchParams.get("token") !== token) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const webhookUrl = process.env.DISCORD_SIGNAL_WEBHOOK_URL;
  if (!webhookUrl) {
    return NextResponse.json(
      { error: "DISCORD_SIGNAL_WEBHOOK_URL is not configured." },
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

  const spec = TIMEFRAMES[payload.tf];
  if (!spec) {
    return NextResponse.json(
      { error: `Unsupported timeframe ${payload.tf}; expected D or 240.` },
      { status: 400 },
    );
  }

  if (payload.event === "sell") {
    await postDiscordPayload(webhookUrl, renderSell(payload, spec.label));
    return NextResponse.json({ ok: true, forwarded: true });
  }

  let found: { rps: number; asOf: string } | null = null;
  let lookupError: string | null = null;
  try {
    found = await latestRps(payload.symbol, spec.tf);
  } catch (error) {
    lookupError = error instanceof Error ? error.message : String(error);
  }

  let gate: Gate;
  if (!found) {
    const why = lookupError ? "面板读取失败" : "不在 Small Fund 池";
    gate = { state: "unknown", field: `\`—\`\n${why}`, note: null };
  } else if (found.rps < spec.rpsMin) {
    // 带一位小数：39.8 取整成 40 会让「RPS 40 < 40」看着像 bug
    gate = {
      state: "reject",
      field: `\`${found.rps.toFixed(1)}\`\n< ${spec.rpsMin} 未达标`,
      note: `RPS 面板截至 ${found.asOf}`,
    };
  } else {
    gate = {
      state: "pass",
      field: `\`${found.rps.toFixed(0)}\`\n≥ ${spec.rpsMin} 通过`,
      note: `RPS 面板截至 ${found.asOf}`,
    };
  }

  await postDiscordPayload(webhookUrl, renderBuy(payload, spec.label, gate));
  return NextResponse.json({
    ok: true,
    forwarded: true,
    gate: gate.state,
    rps: found?.rps ?? null,
    lookupError,
  });
}
