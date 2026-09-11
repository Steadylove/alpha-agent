/** 真实历史回放；默认只生成本地图片，--send 才发到现有 Discord 信号频道。 */
import "dotenv/config";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { deserialize } from "node:v8";
import { runSymbol, type PreparedUniverse } from "@/lib/backtest/engine";
import { champOf } from "@/lib/fund/champs";
import { riskAtrSeries } from "@/lib/scoring/rotationTrade";
import { emaSeries } from "@/lib/scoring/series";
import { fundInputsFromSecFacts, type SecFactsFile } from "@/lib/data-sources/secFacts";
import { fundScoreOf } from "@/lib/scoring/fundScore";
import { distFrom52w } from "@/lib/jobs/fundScore";
import { assessedAlertView } from "@/lib/signals/journal";
import { signalReturnOf } from "@/lib/signals/assessment";
import type { AlertPayload } from "@/lib/discord/tvAlertCopy";
import { renderSignalOgPng } from "@/lib/discord/signalCardOg";
import { signalCardSvg } from "@/lib/discord/signalCardImage";
import { SIGNAL_CARD_WIDTH, SIGNAL_CARD_SCALE } from "@/lib/discord/signalCardLayout";
import { signalChannelId } from "@/lib/optionFlow/publish";

function arg(name: string): string {
  const i = process.argv.indexOf(name);
  if (i < 0 || !process.argv[i + 1] || process.argv[i + 1].startsWith("--")) throw new Error(`需要 ${name}`);
  return resolve(process.argv[i + 1]);
}
const q = (v: number | null) => v == null ? null : Number(v.toFixed(4));
const ms = (date: string) => Date.parse(`${date}Z`);
const hour = (t: number) => Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hourCycle: "h23" }).format(t));
type Example = { symbol: string; event: string; date: string; file: string; caption: string; pnl?: number; score?: number; messageUrl?: string };

async function main() {
  const universe: PreparedUniverse = deserialize(readFileSync(arg("--universe")));
  const secDir = arg("--sec-dir"), marketDir = arg("--market-dir"), out = arg("--out");
  mkdirSync(out, { recursive: true });
  // 示例永远使用独立本地日志，不能把历史回放写进生产入场记录。
  process.env.SIGNAL_JOURNAL_DIR = resolve(out, "journal");
  const champ = champOf("4h");
  const examples: Example[] = [];
  const cases = [{ symbol: "AAPL", signal: "2026-03-23T17:30" }, { symbol: "CF", signal: "2025-11-03T14:30" }];
  for (const selection of cases) {
    const s = universe.symbols.find((v) => v.ticker === selection.symbol);
    assert(s?.open, `${selection.symbol} 缺少历史开盘价`);
    // Pine 在 RPS 闸门前管理持仓，服务端仅筛掉不合格买点。
    const run = runSymbol(universe.axis, { ...s, rps: new Float32Array(s.close.length).fill(50) },
      { ...champ.config, from: universe.axis[0], rpsMin: 0 }, 0, universe.axis.length - 1);
    const trade = run.closed.find((t) => run.bars[t.entryIndex - 1]?.date === selection.signal);
    assert(trade, `${selection.symbol} 指定历史交易不存在`);
    const buyIndex = trade.entryIndex - 1, sellIndex = trade.exitIndex - 1;
    assert(s.rps[buyIndex] >= 30 && (run.buy1[buyIndex] || run.buy2[buyIndex]));
    assert.equal(trade.entryPrice, run.bars[trade.entryIndex].open);
    const atr = riskAtrSeries(run.bars);
    const emas = [166, 169, 576, 676].map((length) => emaSeries(Array.from(s.close), length));
    // 这两笔样例的图示区间无半日市；如换样例，单根交易日必须先核对交易日历。
    const dayCounts = new Map<string, number>();
    for (const b of run.bars) dayCounts.set(b.date.slice(0, 10), (dayCounts.get(b.date.slice(0, 10)) ?? 0) + 1);
    const closeTime = (i: number) => {
      const t = ms(run.bars[i].date);
      assert.equal(dayCounts.get(run.bars[i].date.slice(0, 10)), 2, "示例含单根交易日，需核对半日市边界");
      assert([9, 13].includes(hour(t)), "不是常规时段 4H 数据");
      return t + (hour(t) === 9 ? 4 : 2.5) * 3600000;
    };
    function chart(end: number, anchor: number) {
      const window = Math.min(2000, end + 1, Math.max(80, end - anchor + 21));
      const stride = Math.ceil(window / 120), bars = [];
      for (let group = Math.ceil(window / stride) - 1; group >= 0; group--) {
        const newer = end - group * stride, older = end - Math.min(window - 1, group * stride + stride - 1);
        const slice = run.bars.slice(older, newer + 1);
        bars.push([ms(run.bars[older].date), closeTime(newer), q(run.bars[older].open!),
          q(Math.max(...slice.map((b) => b.high))), q(Math.min(...slice.map((b) => b.low))), q(run.bars[newer].close), ...emas.map((e) => q(e[newer]))]);
      }
      return { version: 1, stride, bars };
    }
    const identity = { strategyKey: "aa-4h-v1|historical-replay|4|6|3|rsi30|vegas166-169-576-676", entrySignalTime: closeTime(buyIndex) };
    const buy: AlertPayload = { ...identity, event: "buy", symbol: s.ticker, tf: "240", kind: trade.sigType,
      price: q(run.bars[buyIndex].close)!, atr: q(atr[buyIndex])!, stopMult: 4, barTime: closeTime(buyIndex), chart: chart(buyIndex, buyIndex) };
    const exit = run.days[sellIndex];
    const heldBars = run.bars.slice(trade.entryIndex, sellIndex + 1);
    const sell: AlertPayload = { ...identity, event: "sell", symbol: s.ticker, tf: "240", kind: trade.sigType,
      price: q(run.bars[sellIndex].close)!, entry: q(trade.entryPrice)!, entryTime: ms(trade.entryDate), barTime: closeTime(sellIndex),
      stop: q(exit.effectiveStop)!, target: q(exit.targetLevel) ?? undefined, initialRisk: q(4 * atr[buyIndex]!)!,
      highSinceEntry: q(Math.max(trade.entryPrice, ...heldBars.map((b) => b.high)))!, lowSinceEntry: q(Math.min(trade.entryPrice, ...heldBars.map((b) => b.low)))!,
      barsHeld: heldBars.length, atr: q(atr[sellIndex])!, chart: chart(sellIndex, trade.entryIndex),
      exitReason: trade.exitReason === "target" ? "target" : exit.trailLevel! > exit.stopLevel! ? "trailing_stop" : exit.stopLevel! > trade.entryPrice ? "protective_stop" : "initial_stop" };
    sell.pnl = Number(signalReturnOf(sell)!.toFixed(2));
    assert(trade.exitReason === "target" ? sell.price >= sell.target! : sell.price < sell.stop!);
    const sec: SecFactsFile = JSON.parse(readFileSync(resolve(secDir, `${s.ticker}.json`), "utf8"));
    const daily = readFileSync(resolve(marketDir, "1d", `${s.ticker}.csv`), "utf8").trim().split("\n").slice(1).map((line) => line.split(","));
    for (const [payload, index] of [[buy, buyIndex], [sell, sellIndex]] as const) {
      const date = run.bars[index].date.slice(0, 10);
      // SEC 只有披露日，保守排除信号同日披露，避免盘后财报穿越到盘中买点。
      const financialAsOf = new Date(Date.parse(`${date}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);
      const financial = fundScoreOf({ ...fundInputsFromSecFacts(sec, financialAsOf),
        dist52w: distFrom52w(daily.filter((b) => b[0] <= financialAsOf).map((b) => Number(b[4]))) });
      const view = await assessedAlertView(payload, "4H", s.rps[index], financial);
      assert(view.chart && view.assessment, "真实行情图/评分缺失");
      assert(!view.assessment.lines.some((line) => line.includes("异常")), "复盘数字不一致");
      if (payload.event === "sell") assert(!view.assessment.headline.includes("未记录"), "入场快照关联失败");
      view.title = `${view.title} · 历史回放 ${date}`;
      const name = `${s.ticker}-${payload.event}-${date}`;
      const file = resolve(out, `${name}.png`);
      writeFileSync(resolve(out, `${name}.json`), JSON.stringify({ payload, financialAsOf, financial, view }, null, 2));
      writeFileSync(resolve(out, `${name}.svg`), signalCardSvg(view));
      writeFileSync(file, await renderSignalOgPng(view));
      examples.push({ symbol: s.ticker, event: payload.event, date, file, pnl: view.pnl, score: view.quality?.points,
        caption: `**历史回放示例｜${s.ticker}｜${view.title}**\n真实历史行情 + 当时已披露财务数据；策略模拟，非实时买卖信号。` });
      console.log(JSON.stringify({ generated: name, score: view.quality?.points, review: view.assessment.headline, financialAsOf }));
    }
  }
  const manifestFile = resolve(out, "manifest.json");
  // 恢复已确认的发送回执，运行脚本不会重复推送同一批样例。
  const previous: Example[] = existsSync(manifestFile) ? JSON.parse(readFileSync(manifestFile, "utf8")) : [];
  for (const example of examples) example.messageUrl = previous.find((p) => p.file === example.file)?.messageUrl;
  writeFileSync(manifestFile, JSON.stringify(examples, null, 2));
  if (process.argv.includes("--send")) {
    const hook = process.env.DISCORD_SIGNAL_WEBHOOK_URL || process.env.DISCORD_WEBHOOK_URL;
    const channelId = signalChannelId();
    let url: URL;
    let headers: Record<string, string> = {};
    let guildId: string;
    if (hook) {
      url = new URL(hook);
      assert(["discord.com", "discordapp.com"].includes(url.hostname) && url.protocol === "https:");
      const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
      assert(response.ok, `无法确认 Discord 目的地 HTTP ${response.status}`);
      const meta = await response.json() as { channel_id: string; guild_id: string };
      assert.equal(meta.channel_id, channelId, "Webhook 与已配置的信号频道不一致，停止发送");
      guildId = meta.guild_id;
      url.searchParams.set("wait", "true");
    } else {
      assert(process.env.DISCORD_BOT_TOKEN, "缺少 Discord 推送凭据");
      headers = { authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}` };
      const response = await fetch(`https://discord.com/api/v10/channels/${channelId}`, { headers, signal: AbortSignal.timeout(15000) });
      assert(response.ok, `无法确认 Discord 目的地 HTTP ${response.status}`);
      const channel = await response.json() as { id: string; guild_id: string };
      assert.equal(channel.id, channelId);
      guildId = channel.guild_id;
      url = new URL(`https://discord.com/api/v10/channels/${channelId}/messages`);
    }
    assert(guildId, "缺少 Discord 服务器信息");
    for (const example of examples) {
      if (example.messageUrl) continue;
      const form = new FormData();
      const filename = `${example.symbol}-${example.event}-historical.png`;
      form.append("payload_json", JSON.stringify({ content: example.caption, allowed_mentions: { parse: [] }, embeds: [{ image: { url: `attachment://${filename}` } }] }));
      form.append("files[0]", new Blob([new Uint8Array(readFileSync(example.file))], { type: "image/png" }), filename);
      // 不在超时后自动重发，避免 HTTP 结果不明时产生重复消息。
      const response = await fetch(url, { method: "POST", headers, body: form, signal: AbortSignal.timeout(30000) });
      assert(response.ok, `Discord 发送未确认 HTTP ${response.status}，请核对频道后再试`);
      const message = await response.json() as { id: string; channel_id: string;
        attachments?: { filename?: string; width?: number; height?: number }[];
        embeds?: { image?: { url?: string; width?: number; height?: number } }[] };
      // attachment:// 用于 embed 时，Discord 可能将图片移到 embeds.image，attachments 为空。
      const imageWidth = SIGNAL_CARD_WIDTH * SIGNAL_CARD_SCALE;
      const hasImage = message.attachments?.some((a) => a.filename === filename && a.width === imageWidth && (a.height ?? 0) > 0) ||
        message.embeds?.some((e) => e.image?.url?.includes(`/${filename}`) && e.image.width === imageWidth && (e.image.height ?? 0) > 0);
      assert(message.id && message.channel_id === channelId && hasImage, "Discord 图片回执不完整；先核对已发送消息，不要直接重试");
      example.messageUrl = `https://discord.com/channels/${guildId}/${channelId}/${message.id}`;
      writeFileSync(manifestFile, JSON.stringify(examples, null, 2));
      console.log(JSON.stringify({ sent: example.symbol, event: example.event, messageUrl: example.messageUrl }));
    }
  }
}
main().catch((error) => { console.error(error instanceof Error ? error.message : "生成失败"); process.exitCode = 1; });
