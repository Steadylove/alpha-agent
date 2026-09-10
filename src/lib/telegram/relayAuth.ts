import { createHmac, timingSafeEqual } from "node:crypto";

export function relayHeaders(secret: string, body = "", now = Date.now()): Record<string, string> {
  const time = String(now);
  return { "x-relay-time": time, "x-relay-signature": createHmac("sha256", secret).update(`${time}\n${body}`).digest("hex") };
}

export function verifyRelay(secret: string, time: string, signature: string, body: string, now = Date.now()) {
  if (!secret || !/^\d{13}$/.test(time) || Math.abs(now - Number(time)) > 300_000 || !/^[a-f0-9]{64}$/.test(signature)) return false;
  return timingSafeEqual(Buffer.from(signature, "hex"), Buffer.from(relayHeaders(secret, body, Number(time))["x-relay-signature"], "hex"));
}
