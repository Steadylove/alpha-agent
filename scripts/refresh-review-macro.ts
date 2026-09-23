import "dotenv/config";
import { refreshReviewMacro } from "@/lib/data-sources/reviewMacro";
import { lastSettledSession } from "@/lib/backtest/mergeBars";
const until =
  process.argv.find((a) => a.startsWith("--date="))?.slice(7) ??
  lastSettledSession();
if (!/^\d{4}-\d{2}-\d{2}$/.test(until)) throw new Error("Invalid date");
refreshReviewMacro(until)
  .then((a) => {
    console.log(
      JSON.stringify(
        {
          updatedAt: a.updatedAt,
          latest: Object.fromEntries(
            Object.entries(a.series).map(([id, rows]) => [
              id,
              rows?.at(-1)?.observationDate,
            ]),
          ),
          errors: a.errors,
        },
        null,
        2,
      ),
    );
    if (a.errors.length) process.exitCode = 1;
  })
  .catch((e) => {
    console.error(e instanceof Error ? e.message : "Macro refresh failed");
    process.exitCode = 1;
  });
