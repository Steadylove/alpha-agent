import { request } from "node:https";

const DISCORD_LIMIT = 1900;

export type DiscordEmbed = {
  title?: string;
  description?: string;
  color?: number;
  image?: { url: string };
  fields?: Array<{
    name: string;
    value: string;
    inline?: boolean;
  }>;
  footer?: { text: string };
};

export type DiscordPayload = {
  content?: string;
  embeds?: DiscordEmbed[];
};

export function chunkDiscordMessage(message: string, limit = DISCORD_LIMIT): string[] {
  if (message.length <= limit) {
    return [message];
  }

  const chunks: string[] = [];
  let remaining = message;

  while (remaining.length > 0) {
    const slice = remaining.slice(0, limit);
    const splitAt = slice.lastIndexOf("\n");
    const chunk = splitAt > 500 ? slice.slice(0, splitAt) : slice;
    chunks.push(chunk);
    remaining = remaining.slice(chunk.length).trimStart();
  }

  return chunks;
}

export async function sendDiscordWebhook(input: {
  webhookUrl: string;
  content: string;
}): Promise<void> {
  const chunks = chunkDiscordMessage(input.content);

  for (const chunk of chunks) {
    const response = await fetch(input.webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: chunk }),
    });

    if (!response.ok) {
      throw new Error(`Discord webhook failed: ${response.status}`);
    }
  }
}

export async function postDiscordBotImage(
  channelId: string,
  token: string,
  input: { filename: string; bytes: Buffer; content?: string },
): Promise<void> {
  const payload = {
    content: input.content ?? "",
    embeds: [{ color: 0x131722, image: { url: `attachment://${input.filename}` } }],
  };
  const form = new FormData();
  form.append("payload_json", JSON.stringify(payload));
  form.append("files[0]", new Blob([new Uint8Array(input.bytes)], { type: "image/png" }), input.filename);
  const response = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
    method: "POST",
    headers: { authorization: `Bot ${token}`, "user-agent": "alpha-agent-option-flow" },
    body: form,
  });
  if (!response.ok) throw new Error(`Discord 发图失败 HTTP ${response.status}`);
}

export async function postDiscordImage(
  webhookUrl: string,
  input: { filename: string; bytes: Buffer; content?: string },
): Promise<void> {
  const payload = {
    content: input.content ?? "",
    embeds: [{ color: 0x131722, image: { url: `attachment://${input.filename}` } }],
  };

  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const form = new FormData();
      form.append("payload_json", JSON.stringify(payload));
      form.append(
        "files[0]",
        new Blob([new Uint8Array(input.bytes)], { type: "image/png" }),
        input.filename,
      );
      const response = await fetch(webhookUrl, {
        method: "POST",
        body: form,
        keepalive: false,
      });
      if (response.ok) return;
      lastError = new Error(`Discord webhook failed: ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    if (attempt < 3) {
      await new Promise((resolve) => setTimeout(resolve, attempt * 500));
    }
  }

  throw lastError instanceof Error ? lastError : new Error("Discord webhook failed.");
}

export async function postDiscordPayload(
  webhookUrl: string,
  payload: DiscordPayload,
): Promise<void> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(webhookUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          connection: "close",
        },
        body: JSON.stringify(payload),
        keepalive: false,
      });

      if (response.ok) {
        return;
      }

      lastError = new Error(`Discord webhook failed: ${response.status}`);
    } catch (error) {
      lastError = error;
    }

    if (attempt < 3) {
      await new Promise((resolve) => setTimeout(resolve, attempt * 500));
    }
  }

  try {
    await postDiscordPayloadWithHttps(webhookUrl, payload);
    return;
  } catch (error) {
    lastError = error;
  }

  throw lastError instanceof Error ? lastError : new Error("Discord webhook failed.");
}

function postDiscordPayloadWithHttps(webhookUrl: string, payload: DiscordPayload): Promise<void> {
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

        reject(new Error(`Discord webhook failed: ${res.statusCode}`));
      },
    );

    req.on("error", reject);
    req.write(body);
    req.end();
  });
}
