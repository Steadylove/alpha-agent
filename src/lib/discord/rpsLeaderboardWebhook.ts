import { request } from "node:https";
import {
  ELITE_RPS_THRESHOLD,
  type EliteRow,
  type RpsLeaderboardResult,
} from "@/lib/jobs/rpsLeaderboard";

const DISCORD_FIELD_VALUE_LIMIT = 1024;
const ROWS_PER_FIELD = 25;

type DiscordEmbed = {
  title: string;
  description?: string;
  color?: number;
  fields?: Array<{ name: string; value: string; inline?: boolean }>;
  footer?: { text: string };
};

const truncate = (v: string, max: number) => (v.length > max ? `${v.slice(0, max - 1)}…` : v);
const fitField = (v: string) => truncate(v, DISCORD_FIELD_VALUE_LIMIT);

const pad = (v: string | number, width: number, align: "left" | "right" = "left") => {
  const s = String(v);
  if (s.length >= width) return s;
  return align === "left" ? s.padEnd(width, " ") : s.padStart(width, " ");
};

function buildEliteTable(rows: EliteRow[]): string {
  const lines = ["Sym    20    50   120   250", "─────  ────  ────  ────  ────"];
  for (const row of rows) {
    lines.push(
      [
        pad(row.symbol, 5),
        pad(row.rps20.toFixed(1), 4, "right"),
        pad(row.rps50.toFixed(1), 4, "right"),
        pad(row.rps120.toFixed(1), 4, "right"),
        pad(row.rps250.toFixed(1), 4, "right"),
      ].join("  "),
    );
  }
  return "```\n" + lines.join("\n") + "\n```";
}

function buildEliteEmbed(result: RpsLeaderboardResult): DiscordEmbed {
  const rows = result.elite;
  const fields: NonNullable<DiscordEmbed["fields"]> = [];

  if (rows.length === 0) {
    fields.push({
      name: "结果",
      value: "无标的满足四周期均 > " + ELITE_RPS_THRESHOLD,
      inline: false,
    });
  } else {
    for (let start = 0; start < rows.length; start += ROWS_PER_FIELD) {
      const chunk = rows.slice(start, start + ROWS_PER_FIELD);
      const end = start + chunk.length;
      fields.push({
        name: `#${start + 1}–${end}`,
        value: fitField(buildEliteTable(chunk)),
        inline: false,
      });
    }
  }

  return {
    title: `四周期共振 · RPS 均 > ${ELITE_RPS_THRESHOLD}`,
    description: [
      `命中 \`${rows.length}\` / 可排名 \`${result.rankedSize}\``,
      `条件 \`RPS20 & RPS50 & RPS120 & RPS250 > ${ELITE_RPS_THRESHOLD}\``,
    ].join("\n"),
    color: 0x22c55e,
    fields,
    footer: {
      text: `Generated ${result.generatedAt.toISOString().slice(0, 16).replace("T", " ")} UTC`,
    },
  };
}

function post(webhookUrl: string, payload: object): Promise<void> {
  return new Promise((resolve, reject) => {
    const url = new URL(webhookUrl);
    const body = JSON.stringify(payload);
    const req = request(
      {
        method: "POST",
        hostname: url.hostname,
        path: `${url.pathname}${url.search}`,
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
        },
      },
      (res) => {
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          resolve();
          return;
        }
        let chunk = "";
        res.on("data", (d) => {
          chunk += d;
        });
        res.on("end", () => {
          reject(new Error(`Discord webhook failed: ${res.statusCode} ${chunk.slice(0, 200)}`));
        });
      },
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

/** 只推四周期均 > 门槛的共振名单（不推 Top100 全量）。 */
export async function sendRpsLeaderboardToDiscord(
  webhookUrl: string,
  result: RpsLeaderboardResult,
): Promise<void> {
  await post(webhookUrl, {
    content: `🧭 **Market Compass · 四周期 RPS 均 > ${ELITE_RPS_THRESHOLD}**（命中 ${result.elite.length}）`,
    embeds: [buildEliteEmbed(result)],
  });
}
