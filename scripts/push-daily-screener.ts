import "dotenv/config";

import { sendAlphaScreenerToDiscord } from "@/lib/discord/screenerWebhook";
import { runAlphaScreenerJob } from "@/lib/jobs/alphaScreener";

function envFlag(name: string, defaultValue: boolean): boolean {
  const value = process.env[name];
  if (value === undefined) return defaultValue;
  return !["0", "false", "no", "off"].includes(value.toLowerCase());
}

async function main() {
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL || "";
  const skipAi = envFlag("SCREENER_SKIP_AI", true);
  const result = await runAlphaScreenerJob({ skipAi });

  await sendAlphaScreenerToDiscord(webhookUrl, result);

  console.log(
    JSON.stringify({
      ok: true,
      skipAi,
      elite: result.elite.length,
      newHighs: result.newHighs.length,
      dailyFetchErrors: result.dailyFetchErrors,
    }),
  );
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
