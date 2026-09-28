import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { appConfig } from "../../../../../app.config";
import { intradaySignalSchema } from "@/lib/intraday/protocol";
import { validDate } from "@/lib/intraday/store";
import { loadRuntimeConfig } from "@/lib/runtimeConfig";
import { readIntradayJournal, relayIntradaySignal, RelayHttpError } from "@/lib/telegram/relay";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const secret = new URL(request.url).searchParams.get("key") ?? "";
  if (!/^[a-f0-9]{64}$/.test(secret)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (Number(request.headers.get("content-length")) > appConfig.intraday.maxBodyBytes) return NextResponse.json({ error: "too large" }, { status: 413 });
  try {
    const reader = request.body?.getReader();
    if (!reader) return NextResponse.json({ error: "invalid signal" }, { status: 400 });
    const chunks: Uint8Array[] = []; let size = 0;
    while (true) {
      const item = await reader.read(); if (item.done) break;
      size += item.value.length;
      if (size > appConfig.intraday.maxBodyBytes) { await reader.cancel(); return NextResponse.json({ error: "too large" }, { status: 413 }); }
      chunks.push(item.value);
    }
    const parsed = intradaySignalSchema.safeParse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    if (!parsed.success) return NextResponse.json({ error: "invalid signal" }, { status: 400 });
    // Success means the VPS has synchronously persisted the signal, not just scheduled after().
    const result = await relayIntradaySignal(JSON.stringify(parsed.data), secret);
    return NextResponse.json(result, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    const status = error instanceof SyntaxError ? 400 : error instanceof RelayHttpError && [400, 401, 413].includes(error.status) ? error.status : 503;
    return NextResponse.json({ error: status === 503 ? "archive unavailable" : "request rejected" }, { status });
  }
}

/** Private, date-based JSON/CSV export for replay; excludes credentials and webhook addresses. */
export async function GET(request: Request) {
  try {
    await loadRuntimeConfig();
    const expected = process.env.CRON_SECRET || "", got = request.headers.get("authorization") ?? "";
    const wanted = `Bearer ${expected}`;
    if (!expected || expected === "change-me" || Buffer.byteLength(got) !== Buffer.byteLength(wanted) || !timingSafeEqual(Buffer.from(got), Buffer.from(wanted))) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    const url = new URL(request.url), date = url.searchParams.get("date") ?? "";
    if (!validDate(date)) return NextResponse.json({ error: "invalid date" }, { status: 400 });
    const data = await readIntradayJournal(date);
    if (url.searchParams.get("format") !== "csv") return NextResponse.json(data, { headers: { "cache-control": "no-store" } });
    const cell = (v: unknown) => {
      const value = String(v ?? "");
      return `"${(typeof v === "string" && /^[=+@\-\t\r]/.test(value) ? "'" + value : value).replaceAll('"', '""')}"`;
    };
    const headers = ["id", "trade_id", "entry_seen_at_receipt", "session_date_et", "symbol", "event", "reason", "signal_time_utc", "received_at_utc", "signal_price", "entry_signal_price", "locked_stop", "disposition", "processing_state", "processing_reason", "script_version", "strategy_key", "metrics_json", "parameters_json", "deliveries_json", "telegram_deliveries_json"];
    const rows = data.records.map(r => [r.id, r.tradeId, r.entrySeenAtReceipt, r.date, r.payload.symbol, r.payload.event, r.payload.reason,
      new Date(r.payload.signalTime).toISOString(), new Date(r.receivedAt).toISOString(), r.payload.price, r.payload.entryPrice, r.payload.stop,
      r.disposition, r.state, r.reason, r.payload.scriptVersion, r.payload.strategyKey, JSON.stringify(r.payload.metrics), JSON.stringify(r.payload.parameters), JSON.stringify(r.deliveries ?? []), JSON.stringify(r.telegramDeliveries)]);
    return new Response("\uFEFF" + [headers, ...rows].map(row => row.map(cell).join(",")).join("\r\n"), {
      headers: { "content-type": "text/csv; charset=utf-8", "cache-control": "no-store", "content-disposition": `attachment; filename="intraday-${date}.csv"` },
    });
  } catch { return NextResponse.json({ error: "archive unavailable" }, { status: 503 }); }
}
