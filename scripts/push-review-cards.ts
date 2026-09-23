import "dotenv/config";
import { readFileSync, readdirSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { expectedReviewSession } from "@/lib/review/health";
import { validateReviewCards, parseReviewBars } from "@/lib/review/cardInputs";
import type { RpsCalendar } from "@/lib/backtest/rpsSnapshot";
import type { DailyReview, ReviewIndex } from "@/lib/review/types";
import { tomorrowMapCardSvg } from "@/lib/discord/tomorrowMapCardImage";
import { optionsMapCardSvg, type OptionsMapProfile } from "@/lib/discord/optionsMapCardImage";
import { discordWebhookOf, isDiscordWebhookUrl, readPushRoutes, resolveDiscordTargets } from "@/lib/notifications/pushRoutes";
import { deliverReviewCard, postReviewDiscordImage, reviewDeliveryKey } from "@/lib/notifications/reviewCardDelivery";
import { enqueueTelegramImage } from "@/lib/telegram/relay";

const json = <T>(file: string): T => JSON.parse(readFileSync(file, "utf8")) as T;
async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const root = process.env.MARKET_DATA_DIR;
  if (!root) throw new Error("MARKET_DATA_DIR 未设置");
  if (process.env.MARKET_DATA_BASE_URL) throw new Error("出图任务必须读取本地已完成的收盘数据");
  const expected = expectedReviewSession(json<{ calendar?: RpsCalendar }>(path.join(root, "rps/rps-latest.json")).calendar);
  const reviews = path.join(root, "snapshots/daily-review"), index = json<ReviewIndex>(path.join(reviews, "index.json"));
  if (index.latest !== expected.date) throw new Error("每日复盘尚未完成，停止推送");
  const review = json<DailyReview>(path.join(reviews, `${expected.date}.json`));
  const bars = parseReviewBars(readFileSync(path.join(root, "1d/SPX.csv"), "utf8"));
  const profile = json<OptionsMapProfile>(path.join(root, `snapshots/gex-profiles/${expected.date}/SPX.json`));
  validateReviewCards(review, bars, profile, expected);
  const history = readdirSync(reviews).filter(n => /^\d{4}-\d{2}-\d{2}\.json$/.test(n) && n.slice(0, 10) <= review.date).sort().slice(-11).map(n => json<DailyReview>(path.join(reviews, n)));
  const logo = readFileSync(path.join(process.env.REVIEW_CARD_ASSET_DIR || "src/lib/discord", "trendAdaptiveLogo.svg"), "utf8");
  // The deployed standalone worker resolves native Sharp from the existing repo installation.
  const sharpModule = createRequire(path.join(process.cwd(), "package.json"))("sharp");
  const sharp = (sharpModule.default ?? sharpModule) as typeof import("sharp")["default"];
  const output = path.join(root, `snapshots/${dryRun ? "review-cards-preview" : "review-cards"}/${review.date}`); mkdirSync(output, { recursive: true });
  const cards = [
    { name: "tomorrow-map", title: "Tomorrow Map", svg: tomorrowMapCardSvg(review, history, logo) },
    { name: "options-market-map", title: "Options Market Map", svg: optionsMapCardSvg(review, bars, profile, logo) },
  ];
  // Complete both images before any channel receives either one.
  const rendered = [];
  for (const card of cards) {
    const filename = `${card.name}-${review.date}.png`, file = path.join(output, filename);
    // Freeze the first production PNG for same-day retry consistency. Dry-run previews may refresh.
    const bytes = !dryRun && existsSync(file) ? readFileSync(file) : await sharp(Buffer.from(card.svg), { density: 144 }).png().toBuffer();
    // Relay accepts 8 MB base64, so leave room below its ~6 MB binary ceiling.
    if (bytes.length > 5_800_000) throw new Error(`${card.name} 超过推送图片大小限制`);
    if (dryRun || !existsSync(file)) { writeFileSync(file, bytes); writeFileSync(file.replace(/\.png$/, ".svg"), card.svg); }
    rendered.push({ ...card, filename, bytes, content: `**TREND ADAPTIVE · ${card.title}**\n复盘交易日 ${review.date} ET · 下一交易日 ${expected.next}\n仅供信息参考，不构成投资建议` });
  }
  const route = (await readPushRoutes({ strict: true })).routes.gex;
  if (!route.enabled) { console.log("GEX 路由关闭，两图已归档，不发送"); return; }
  const targets = route.discord ? [...new Set(resolveDiscordTargets(route, d => discordWebhookOf(d)).map(t => t.url))] : [];
  if (route.discord && (!targets.length || targets.some(url => !isDiscordWebhookUrl(url)))) throw new Error("GEX Discord 路由缺失或无效");
  const telegram = route.telegram && (route.telegramAll || route.telegramChats.length > 0);
  console.log(JSON.stringify({ date: review.date, output, cards: rendered.map(c => c.filename), discordTargets: targets.length, telegram, dryRun }));
  if (dryRun) return;
  if (telegram && !process.env.TELEGRAM_RELAY_SECRET) {
    const file = process.env.REVIEW_CARD_TELEGRAM_CONFIG;
    if (file && existsSync(file)) {
      const config = (await import(pathToFileURL(file).href)).default as { relaySecret?: string };
      if (config.relaySecret) process.env.TELEGRAM_RELAY_SECRET = config.relaySecret;
    }
  }
  if (telegram && (!process.env.TELEGRAM_RELAY_SECRET || !process.env.TELEGRAM_RELAY_URL)) throw new Error("Telegram 服务鉴权未配置，停止本次推送");
  const stateFile = path.join(process.env.REVIEW_CARD_STATE_DIR || path.join(root, ".review-card-delivery"), `${review.date}.json`);
  const failures: string[] = [];
  for (const card of rendered) {
    for (let i = 0; i < targets.length; i++) {
      const key = reviewDeliveryKey(review.date, card.name, targets[i]);
      try { console.log(`${card.name} Discord #${i + 1}:`, await deliverReviewCard(stateFile, key, () => postReviewDiscordImage(targets[i], card))); }
      catch (error) { failures.push(`${card.name} Discord #${i + 1}: ${error instanceof Error ? error.message : "发送失败"}`); }
    }
    if (telegram) {
      const chats = route.telegramAll ? undefined : [...route.telegramChats].sort();
      const key = reviewDeliveryKey(review.date, card.name, `telegram:${JSON.stringify(chats ?? "all")}`);
      try {
        console.log(`${card.name} Telegram:`, await deliverReviewCard(stateFile, key, async () => {
          const result = await enqueueTelegramImage({ ...card, eventKey: key }, chats);
          if ("skipped" in result || !result.ok) throw new Error("Telegram 推送服务未启用");
          if (!result.recipients) throw new Error("Telegram 当前没有可接收的目标，未记为发送成功");
          return undefined;
        }, true));
      } catch (error) { failures.push(`${card.name} Telegram: ${error instanceof Error ? error.message : "发送失败"}`); }
    }
  }
  if (failures.length) throw new Error(failures.join("; "));
}
main().catch(error => { console.error(error instanceof Error ? error.message : "复盘图任务失败"); process.exitCode = 1; });
