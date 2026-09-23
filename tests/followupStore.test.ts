import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { readFollowupExits } from "@/lib/review/followupStore";
import { tradeIdOf } from "@/lib/signals/journal";
import type { AlertPayload } from "@/lib/discord/tvAlertCopy";

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "followup-store-"));
  roots.push(root);
  vi.stubEnv("SIGNAL_JOURNAL_DIR", root);
  const dir = path.join(root, "signal-reviews");
  mkdirSync(dir);
  const payload = {
    symbol: "DELL",
    tf: "2h",
    event: "sell",
    strategyKey: "test",
    entrySignalTime: Date.parse("2026-09-21T17:30:00Z"),
    barTime: Date.parse("2026-09-22T17:30:00Z"),
  } as AlertPayload;
  const id = tradeIdOf(payload)!;
  const record = {
    version: 1,
    id,
    payload,
    capturedAt: "2026-09-22T17:30:01Z",
  };
  return { id, record, file: path.join(dir, `${id}.json`) };
}
it("只读取关联的卖出留档；不修改原文件，缺记录不代表活跃", async () => {
  const { id, record, file } = fixture();
  expect(await readFollowupExits([id])).toEqual({ exits: [], failed: false });
  writeFileSync(file, JSON.stringify(record));
  expect(await readFollowupExits([id])).toEqual({
    exits: [
      { id, eventTime: record.payload.barTime, capturedAt: record.capturedAt },
    ],
    failed: false,
  });
});
it("错误身份、未知事件或损坏留档报告读取失败", async () => {
  const { id, record, file } = fixture();
  writeFileSync(
    file,
    JSON.stringify({
      ...record,
      payload: { ...record.payload, event: "unknown" },
    }),
  );
  expect(await readFollowupExits([id])).toEqual({ exits: [], failed: true });
  writeFileSync(
    file,
    JSON.stringify({
      ...record,
      payload: { ...record.payload, symbol: "OTHER" },
    }),
  );
  expect(await readFollowupExits([id])).toEqual({ exits: [], failed: true });
  writeFileSync(file, "{");
  expect(await readFollowupExits([id])).toEqual({ exits: [], failed: true });
});
