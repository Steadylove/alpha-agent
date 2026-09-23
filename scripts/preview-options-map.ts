import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { DailyReview } from "@/lib/review/types";
import { optionsMapCardSvg, type OptionsMapBar, type OptionsMapProfile } from "@/lib/discord/optionsMapCardImage";

async function main() {
  const [reviewFile, csvFile, profileFile, output = ".tmp/options-map-preview"] = process.argv.slice(2);
  if (!reviewFile || !csvFile || !profileFile) throw new Error("用法：preview-options-map <review.json> <SPX.csv> <profile.json> [输出目录]");
  const review = JSON.parse(readFileSync(reviewFile, "utf8")) as DailyReview;
  const profile = JSON.parse(readFileSync(profileFile, "utf8")) as OptionsMapProfile;
  const [header, ...records] = readFileSync(csvFile, "utf8").trim().split(/\r?\n/);
  const columns = header.split(",");
  const bars = records.map(row => {
    const v = row.split(",");
    return Object.fromEntries(["date", "open", "high", "low", "close"].map(key => [key, key === "date" ? v[columns.indexOf(key)].slice(0, 10) : Number(v[columns.indexOf(key)])])) as OptionsMapBar;
  });
  if (review.version !== 1 || !/^\d{4}-\d{2}-\d{2}$/.test(review.date)) throw new Error("无效复盘快照");
  if (bars.some(b => ![b.open, b.high, b.low, b.close].every(Number.isFinite) || b.low > Math.min(b.open, b.close) || b.high < Math.max(b.open, b.close))) throw new Error("无效 OHLC");
  if (!profile.rows.length || profile.rows.some(r => ![r.strike, r.call_gex, r.put_gex, r.net_gex].every(Number.isFinite))) throw new Error("无效 Gamma 分布");
  if (Math.abs(profile.rows.reduce((sum, r) => sum + r.net_gex, 0) - profile.netGex) > 100) throw new Error("Gamma 分布总和不一致");
  const logo = readFileSync("src/lib/discord/trendAdaptiveLogo.svg", "utf8");
  const svg = optionsMapCardSvg(review, bars, profile, logo);
  const root = path.resolve(output); mkdirSync(root, { recursive: true });
  const file = path.join(root, `options-market-map-${review.date}`);
  writeFileSync(`${file}.svg`, svg);
  const { default: sharp } = await import("sharp");
  await sharp(Buffer.from(svg), { density: 144 }).png().toFile(`${file}.png`);
  console.log(JSON.stringify({ png: `${file}.png`, svg: `${file}.svg`, date: review.date, candles: bars.filter(b => b.date <= review.date).slice(-45).length, profileStrikes: profile.rows.length }, null, 2));
}
main().catch(e => { console.error(e); process.exitCode = 1; });
