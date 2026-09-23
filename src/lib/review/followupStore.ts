import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { deskRemoteUrl, readDeskJson } from "@/lib/fund/deskRemote";
import { tradeIdOf } from "@/lib/signals/journal";
import type { AlertPayload } from "@/lib/discord/tvAlertCopy";
import type { SignalExit } from "./followup";

/** Read linked exit records only; never scan Discord messages or assume missing means active. */
export async function readFollowupExits(ids: string[]) {
  const exits: SignalExit[] = [];
  let failed = false;
  for (let i = 0; i < ids.length; i += 8) {
    await Promise.all(
      ids.slice(i, i + 8).map(async (id) => {
        if (!/^[a-f0-9]{64}$/.test(id)) return;
        try {
          const name = `signal-reviews/${id}.json`;
          let raw: unknown;
          if (!process.env.SIGNAL_JOURNAL_DIR && deskRemoteUrl(name))
            raw = await readDeskJson(name, AbortSignal.timeout(4000));
          else {
            if (!process.env.SIGNAL_JOURNAL_DIR && process.env.VERCEL)
              throw new Error("缺少持久化信号存储");
            const file = path.join(
              process.env.SIGNAL_JOURNAL_DIR || ".cache/signal-journal",
              name,
            );
            raw = existsSync(file)
              ? JSON.parse(readFileSync(file, "utf8"))
              : null;
          }
          if (!raw) return;
          const v = raw as {
            version: number;
            id: string;
            payload: AlertPayload;
            capturedAt: string;
          };
          if (
            v.version !== 1 ||
            v.id !== id ||
            tradeIdOf(v.payload) !== id ||
            v.payload.event !== "sell" ||
            !Number.isFinite(Date.parse(v.capturedAt))
          ) {
            failed = true;
            return;
          }
          exits.push({
            id,
            eventTime: v.payload.barTime!,
            capturedAt: v.capturedAt,
          });
        } catch {
          failed = true;
        }
      }),
    );
  }
  return { exits, failed };
}
