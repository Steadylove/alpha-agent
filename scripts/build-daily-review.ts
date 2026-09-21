import "dotenv/config";
import { buildDailyReview } from "@/lib/review/build";

const dateArg = process.argv.find((a) => a.startsWith("--date="))?.slice(7);
buildDailyReview(dateArg)
  .then((r) => {
    console.log(
      JSON.stringify(
        {
          date: r.date,
          regime: r.market.regime,
          signals: r.signals.length,
          warnings: r.warnings,
        },
        null,
        2,
      ),
    );
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.message : "复盘生成失败");
    process.exitCode = 1;
  });
