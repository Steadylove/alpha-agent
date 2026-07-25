import { request } from "node:https";
import { renderScreenerCardPng } from "@/lib/discord/screenerCardImage";
import type { ScreenerResult, ScreenerRow } from "@/lib/jobs/alphaScreener";
import { BASE_RPS_THRESHOLD } from "@/lib/scoring/rpsPlaybooks";

type DiscordEmbed = {
  title?: string;
  description?: string;
  image?: { url: string };
  color?: number;
};

function postJson(webhookUrl: string, payload: object): Promise<void> {
  return new Promise((resolve, reject) => {
    const url = new URL(webhookUrl);
    const body = Buffer.from(JSON.stringify(payload));
    const req = request(
      {
        method: "POST",
        hostname: url.hostname,
        path: `${url.pathname}${url.search}`,
        headers: {
          "content-type": "application/json",
          "content-length": body.length,
        },
      },
      (res) => {
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          resolve();
          return;
        }
        let chunk = "";
        res.on("data", (d) => { chunk += d; });
        res.on("end", () => reject(new Error(`Discord JSON failed: ${res.statusCode} ${chunk.slice(0, 200)}`)));
      },
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function postMultipart(
  webhookUrl: string,
  payload: object,
  file: { filename: string; bytes: Buffer; contentType: string },
): Promise<void> {
  return new Promise((resolve, reject) => {
    const url = new URL(webhookUrl);
    const boundary = `----mc${Date.now().toString(16)}`;
    const jsonPart = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="payload_json"\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(payload)}\r\n`,
    );
    const fileHead = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="files[0]"; filename="${file.filename}"\r\nContent-Type: ${file.contentType}\r\n\r\n`,
    );
    const fileTail = Buffer.from(`\r\n--${boundary}--\r\n`);
    const body = Buffer.concat([jsonPart, fileHead, file.bytes, fileTail]);

    const req = request(
      {
        method: "POST",
        hostname: url.hostname,
        path: `${url.pathname}${url.search}`,
        headers: {
          "content-type": `multipart/form-data; boundary=${boundary}`,
          "content-length": body.length,
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

/** 每日推送：先发总览图片，随后发送各股 AI 深度分析 */
export async function sendAlphaScreenerToDiscord(
  webhookUrl: string,
  result: ScreenerResult,
): Promise<void> {
  const png = await renderScreenerCardPng(result);
  const filename = "screener.png";
  const imageEmbed: DiscordEmbed = {
    color: 0x131722,
    image: { url: `attachment://${filename}` },
  };

  // 1. 发送图片总览
  await postMultipart(
    webhookUrl,
    {
      content: result.elite.length === 0 ? `今日无命中（RPS > ${BASE_RPS_THRESHOLD}）` : "",
      embeds: [imageEmbed],
    },
    { filename, bytes: png, contentType: "image/png" },
  );

  // 2. 发送 AI 分析（每股单独卡片）
  const analysisEmbeds: DiscordEmbed[] = [];
  for (const row of result.elite) {
    if (row.alphaAnalysis) {
      let desc = row.alphaAnalysis;
      if (desc.length > 4000) {
        desc = desc.slice(0, 4000) + "...";
      }
      analysisEmbeds.push({
        title: `⚡ Alpha 深度推演: ${row.symbol}`,
        description: desc,
        color: 0x26A69A, // TradingView Green
      });
    }
  }

  // 批量发送 embed，每条消息最多 10 个 embed
  for (let i = 0; i < analysisEmbeds.length; i += 10) {
    const chunk = analysisEmbeds.slice(i, i + 10);
    if (chunk.length > 0) {
      await new Promise(r => setTimeout(r, 1000));
      await postJson(webhookUrl, { embeds: chunk });
    }
  }
}
