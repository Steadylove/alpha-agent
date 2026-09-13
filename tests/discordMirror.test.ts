import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { discordMirrorWebhook, postDiscordMirror } from "@/lib/discord/mirrorWebhook";

const mocks = vi.hoisted(() => ({ discord: vi.fn() }));
vi.mock("@/lib/discord/sendWebhook", () => ({ postDiscordImage: mocks.discord }));

const image = { filename: "gex.png", bytes: Buffer.from("png"), content: "GEX" };

beforeEach(() => vi.resetAllMocks());
afterEach(() => vi.unstubAllEnvs());

it("没配镜像地址就不发", async () => {
  expect(discordMirrorWebhook("gex")).toBe("");
  await postDiscordMirror("", image);
  expect(mocks.discord).not.toHaveBeenCalled();
});

it("按类型读各自的镜像地址", () => {
  vi.stubEnv("DISCORD_MIRROR_GEX_WEBHOOK_URL", "https://discord.example/gex");
  vi.stubEnv("DISCORD_MIRROR_BOOK_WEBHOOK_URL", "https://discord.example/book");
  vi.stubEnv("DISCORD_MIRROR_4H_WEBHOOK_URL", "https://discord.example/4h");
  vi.stubEnv("DISCORD_MIRROR_2H_WEBHOOK_URL", "https://discord.example/2h");
  expect(discordMirrorWebhook("gex")).toBe("https://discord.example/gex");
  expect(discordMirrorWebhook("book")).toBe("https://discord.example/book");
  expect(discordMirrorWebhook("4h")).toBe("https://discord.example/4h");
  expect(discordMirrorWebhook("2h")).toBe("https://discord.example/2h");
});

it("镜像失败不抛，避免挡原频道", async () => {
  mocks.discord.mockRejectedValue(new Error("unavailable"));
  await expect(postDiscordMirror("https://discord.example/gex", image)).resolves.toBeUndefined();
});
