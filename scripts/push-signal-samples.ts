import "dotenv/config";

import { renderSignalPng } from "@/lib/discord/signalCardImage";
import { postDiscordImage } from "@/lib/discord/sendWebhook";
import { buildAlertView, type AlertPayload } from "@/lib/discord/tvAlertCopy";

const samples: Array<{ payload: AlertPayload; label: string; rps?: number }> = [
  {
    payload: { event: "buy", symbol: "NVDA", tf: "240", kind: 1, price: 178.4, atr: 4.2, stopMult: 4 },
    label: "4H",
    rps: 79,
  },
  {
    payload: { event: "sell", symbol: "CAT", tf: "240", kind: 2, price: 412.3, entry: 388.7, pnl: 6.08 },
    label: "4H",
  },
  {
    payload: { event: "sell", symbol: "ADI", tf: "240", kind: 2, price: 214.1, entry: 226.0, pnl: -5.27, stop: 214.1 },
    label: "4H",
  },
];

async function main() {
  const webhook = process.env.DISCORD_SIGNAL_WEBHOOK_URL || process.env.DISCORD_WEBHOOK_URL;
  if (!webhook) throw new Error("未配置 DISCORD_SIGNAL_WEBHOOK_URL / DISCORD_WEBHOOK_URL");

  for (const sample of samples) {
    const view = buildAlertView(sample.payload, sample.label, sample.rps);
    await postDiscordImage(webhook, {
      filename: `signal-${view.symbol}.png`,
      bytes: await renderSignalPng(view),
      content: `**${view.title} · ${view.symbol}** · ${view.tfLabel}`,
    });
    console.log(`${view.title} ${view.symbol}`);
    await new Promise((r) => setTimeout(r, 600));
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
