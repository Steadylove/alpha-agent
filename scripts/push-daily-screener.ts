import "dotenv/config";

import { getPrisma } from "@/lib/db/prisma";
import { sendAlphaScreenerToDiscord } from "@/lib/discord/screenerWebhook";
import { runAlphaScreenerJob } from "@/lib/jobs/alphaScreener";

function envFlag(name: string, defaultValue: boolean): boolean {
  const value = process.env[name];
  if (value === undefined) return defaultValue;
  return !["0", "false", "no", "off"].includes(value.toLowerCase());
}

async function main() {
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
  if (!webhookUrl) {
    throw new Error("Missing DISCORD_WEBHOOK_URL");
  }

  // Daily free-tier job pushes the two images only by default.
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

async function disconnectPrisma() {
  try {
    await getPrisma().$disconnect();
  } catch {
    // The script may fail before Prisma is initialized.
  }
}

main()
  .then(async () => {
    await disconnectPrisma();
    process.exit(0);
  })
  .catch(async (error) => {
    console.error(error);
    await disconnectPrisma();
    process.exit(1);
  });
