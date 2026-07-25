import { request } from "node:https";
import { renderScreenerCardPng } from "@/lib/discord/screenerCardImage";
import type { ScreenerResult, ScreenerRow } from "@/lib/jobs/alphaScreener";
import { BASE_RPS_THRESHOLD } from "@/lib/scoring/rpsPlaybooks";

type DiscordEmbed = {
  image?: { url: string };
  color?: number;
};

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

/** 每日推送：只发筛选图片；一张图展示全部 */
export async function sendAlphaScreenerToDiscord(
  webhookUrl: string,
  result: ScreenerResult,
): Promise<void> {
  const png = await renderScreenerCardPng(result);
  const filename = "screener.png";
  const embed: DiscordEmbed = {
    color: 0x18181b,
    image: { url: `attachment://${filename}` },
  };

  // 只推图片；无命中时保留极短文字，避免 Discord 空消息兼容问题
  await postMultipart(
    webhookUrl,
    {
      content: result.elite.length === 0 ? `今日无命中（RPS > ${BASE_RPS_THRESHOLD}）` : "",
      embeds: [embed],
    },
    { filename, bytes: png, contentType: "image/png" },
  );
}
