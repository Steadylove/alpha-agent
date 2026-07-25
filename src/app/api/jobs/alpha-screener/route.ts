import { NextResponse } from "next/server";
import { runAlphaScreenerJob } from "@/lib/jobs/alphaScreener";
import { sendAlphaScreenerToDiscord } from "@/lib/discord/screenerWebhook";

export const maxDuration = 300;

function parseSkipAi(request: Request): boolean {
  const url = new URL(request.url);
  const queryValue = url.searchParams.get("skipAi");
  if (queryValue !== null) return queryValue !== "false";
  return true;
}

export async function POST(request: Request) {
  const secret = request.headers.get("x-cron-secret");
  if (process.env.CRON_SECRET && secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const skipAi = parseSkipAi(request);
  const result = await runAlphaScreenerJob({ skipAi });
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
  let discordError: string | null = null;
  if (webhookUrl) {
    try {
      await sendAlphaScreenerToDiscord(webhookUrl, result);
    } catch (err) {
      discordError = err instanceof Error ? err.message : String(err);
    }
  }

  return NextResponse.json({
    ok: true,
    universeSize: result.universeSize,
    rankedSize: result.rankedSize,
    baseThreshold: result.baseThreshold,
    skipAi,
    eliteCount: result.elite.length,
    newHighsCount: result.newHighs.length,
    pushedToDiscord: Boolean(webhookUrl) && !discordError,
    elite: result.elite.map((p) => ({
      symbol: p.symbol,
      name: p.name,
      sector: p.sector,
      industry: p.industry,
      industryLabel: p.industryLabel,
      blurb: p.blurb,
      minRps: Number(p.minRps.toFixed(1)),
      rps: {
        20: Number(p.rps[20].toFixed(1)),
        50: Number(p.rps[50].toFixed(1)),
        120: Number(p.rps[120].toFixed(1)),
        250: Number(p.rps[250].toFixed(1)),
      },
    })),
    newHighs: result.newHighs.map((p) => ({
      symbol: p.symbol,
      name: p.name,
      sector: p.sector,
      industry: p.industry,
      industryLabel: p.industryLabel,
      minRps: Number(p.minRps.toFixed(1)),
      rps: {
        20: Number(p.rps[20].toFixed(1)),
        50: Number(p.rps[50].toFixed(1)),
        120: Number(p.rps[120].toFixed(1)),
        250: Number(p.rps[250].toFixed(1)),
      },
    })),
    dailyFetchErrors: result.dailyFetchErrors,
    discordError,
  });
}
