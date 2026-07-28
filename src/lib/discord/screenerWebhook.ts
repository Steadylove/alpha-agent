import { request } from "node:https";
import { renderScreenerCardPng } from "@/lib/discord/screenerCardImage";
import type { ScreenerResult } from "@/lib/jobs/alphaScreener";

type DiscordEmbed = {
  title?: string;
  description?: string;
  image?: { url: string };
  color?: number;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function withDiscordRetry(action: () => Promise<void>, label: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await action();
      return;
    } catch (error) {
      lastError = error;
      if (attempt === 3) break;
      console.warn(`${label} failed, retrying (${attempt}/3)`, error);
      await sleep(1500 * attempt);
    }
  }
  throw lastError;
}

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
  files: Array<{ filename: string; bytes: Buffer; contentType: string }>,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const url = new URL(webhookUrl);
    const boundary = `----mc${Date.now().toString(16)}`;
    
    const parts: Buffer[] = [];
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="payload_json"\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(payload)}\r\n`,
    ));

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      parts.push(Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="files[${i}]"; filename="${file.filename}"\r\nContent-Type: ${file.contentType}\r\n\r\n`,
      ));
      parts.push(file.bytes);
      parts.push(Buffer.from(`\r\n`));
    }
    parts.push(Buffer.from(`--${boundary}--\r\n`));

    const body = Buffer.concat(parts);

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

/** 每日推送：发两张总览图片 (精英池 + 新高池)，随后发送精英池各股 AI 深度分析 */
export async function sendAlphaScreenerToDiscord(
  webhookUrl: string,
  result: ScreenerResult,
): Promise<void> {
  const dateStr = result.generatedAt.toISOString().slice(0, 10);
  const eliteSymbols = new Set(result.elite.map((row) => row.symbol));
  const overlapSymbols = new Set(
    result.newHighs.filter((row) => eliteSymbols.has(row.symbol)).map((row) => row.symbol),
  );
  
  // 1. 发送精英池图片
  const elitePng = await renderScreenerCardPng(
    result,
    result.elite,
    "强势股精英池",
    `${dateStr} // RPS > ${result.baseThreshold} // ROWS: ${result.elite.length} // BOTH: ${overlapSymbols.size}`,
    { overlapSymbols },
  );
  
  // 2. 发送新高池图片
  const newHighsPng = await renderScreenerCardPng(
    result,
    result.newHighs,
    "盘中新高(趋势发现)",
    `${dateStr} // 252日新高 // ROWS: ${result.newHighs.length} // BOTH: ${overlapSymbols.size}`,
    { overlapSymbols },
  );

  const eliteEmbed: DiscordEmbed = {
    color: 0x131722,
    image: { url: `attachment://elite.png` },
  };
  const newHighsEmbed: DiscordEmbed = {
    color: 0x131722,
    image: { url: `attachment://newhighs.png` },
  };

  // 发送多图消息
  await withDiscordRetry(
    () =>
      postMultipart(
        webhookUrl,
        {
          content:
            result.elite.length === 0 && result.newHighs.length === 0 ? `今日无符合条件的标的` : "",
          embeds: [eliteEmbed, newHighsEmbed],
        },
        [
          { filename: "elite.png", bytes: elitePng, contentType: "image/png" },
          { filename: "newhighs.png", bytes: newHighsPng, contentType: "image/png" },
        ],
      ),
    "Discord image push",
  );

  // 3. 发送 AI 分析（仅精英池，每股单独卡片）
  const analysisEmbeds: DiscordEmbed[] = [];
  for (const row of result.elite) {
    if (row.alphaAnalysis) {
      let desc = row.alphaAnalysis;
      if (desc.length > 3500) {
        desc = desc.slice(0, 3500) + "...";
      }
      analysisEmbeds.push({
        title: `⚡ Alpha 深度推演: ${row.symbol}`,
        description: desc,
        color: 0x26A69A, // TradingView Green
      });
    }
  }

  // Discord 每条消息的 embeds 总大小限制为 6000；逐条发送更稳。
  for (const embed of analysisEmbeds) {
    await sleep(1000);
    await withDiscordRetry(() => postJson(webhookUrl, { embeds: [embed] }), "Discord AI push");
  }
}
