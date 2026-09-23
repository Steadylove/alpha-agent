import { readFileSync, readdirSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { DailyReview } from "@/lib/review/types";
import { tomorrowMapCardSvg } from "@/lib/discord/tomorrowMapCardImage";

async function main() {
  const input = process.argv[2];
  if (!input) throw new Error("用法：tsx scripts/preview-tomorrow-map.ts <daily-review/YYYY-MM-DD.json> [输出目录]");
  const review = JSON.parse(readFileSync(input, "utf8")) as DailyReview;
  if (review.version !== 1 || !/^\d{4}-\d{2}-\d{2}$/.test(review.date)) throw new Error("无效的每日复盘快照");
  const root = path.dirname(input);
  const history = readdirSync(root).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f) && f.slice(0, 10) <= review.date).sort().slice(-11).map(f => JSON.parse(readFileSync(path.join(root, f), "utf8")) as DailyReview);
  const logo = readFileSync(path.join(process.cwd(), "src/lib/discord/trendAdaptiveLogo.svg"), "utf8");
  const out = path.resolve(process.argv[3] ?? ".tmp/tomorrow-map-preview/type-v4");
  mkdirSync(out, { recursive: true });
  const { default: sharp } = await import("sharp");
  const svg = tomorrowMapCardSvg(review, history, logo, true);
  const file = path.join(out, `tomorrow-map-${review.date}`);
  writeFileSync(`${file}.svg`, svg);
  // Latin text uses bundled outlines; CJK uses local system fonts. No runtime font downloads.
  await sharp(Buffer.from(svg), { density: 144 }).png().toFile(`${file}.png`);
  console.log(JSON.stringify({ png: `${file}.png`, svg: `${file}.svg`, reviewDate: review.date, targetDate: review.tomorrow?.targetDate, size: await sharp(`${file}.png`).metadata() }, null, 2));
}
main().catch(e => { console.error(e); process.exitCode = 1; });
