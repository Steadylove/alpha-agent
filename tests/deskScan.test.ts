import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_BACKTEST_CONFIG,
  prepareUniverse,
} from "@/lib/backtest/engine";
import { scanDeskBoard } from "@/lib/backtest/deskScan";
import { deskDecisionId, readLedger, upsertDecision } from "@/lib/backtest/deskLedger";
import type { PanelBars } from "@/lib/backtest/panel";

const axisDates = (n: number) =>
  Array.from({ length: n }, (_, i) =>
    new Date(Date.UTC(2000, 0, 3 + i)).toISOString().slice(0, 10),
  );

function rising(ticker: string, dates: string[], start = 50, step = 0.4): PanelBars {
  const n = dates.length;
  const close = new Float32Array(n);
  const high = new Float32Array(n);
  const low = new Float32Array(n);
  const open = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    const c = start + step * i;
    close[i] = c;
    open[i] = c;
    high[i] = c * 1.01;
    low[i] = c * 0.99;
  }
  return { ticker, dates, high, low, close, volume: null, open };
}

describe("deskScan", () => {
  it("列出全池：本根点火记 lastSignal，未持仓则为空仓", () => {
    const dates = axisDates(320);
    const panels = [rising("A", dates, 80, 0.2), rising("B", dates, 80, 0.15)];
    const all = { start: dates[0], end: null };
    const u = prepareUniverse(panels, new Map(panels.map((p) => [p.ticker, [all]])));
    const last = dates.length - 1;
    const a = u.symbols.find((s) => s.ticker === "A")!;
    a.buy1[last] = 1;
    a.rps[last] = 40;
    u.symbols.find((s) => s.ticker === "B")!.rps[last] = 20;

    const snap = scanDeskBoard(u, {
      ...DEFAULT_BACKTEST_CONFIG,
      from: dates[260],
      to: dates[last],
      splitDate: "2099-01-01",
      rpsMin: 0,
      useBuy1: true,
      useBuy2: false,
      requireRsi: false,
      requireVegas: false,
      rpsWeightPower: 1,
    });

    expect(snap.asOf).toBe(dates[last]);
    expect(snap.rows).toHaveLength(2);
    expect(snap.rows.find((r) => r.symbol === "A")).toMatchObject({
      lastSignal: 1,
      holding: null,
      rps: 40,
    });
    expect(snap.rows.find((r) => r.symbol === "B")).toMatchObject({ lastSignal: 0, holding: null });
  });
});

describe("deskLedger", () => {
  const prev = process.env.DESK_LEDGER_PATH;
  afterEach(() => {
    if (prev == null) delete process.env.DESK_LEDGER_PATH;
    else process.env.DESK_LEDGER_PATH = prev;
  });

  it("同信号再写覆盖，账本可回读", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "desk-"));
    process.env.DESK_LEDGER_PATH = path.join(dir, "ledger.json");
    const base = {
      date: "2026-08-25",
      timeframe: "1d",
      poolId: "sf-live",
      symbol: "NVDA",
      sigType: 1 as const,
      rps: 72,
      rawWeightPct: 72,
      note: "",
    };
    upsertDecision({ ...base, decision: "confirm" });
    const again = upsertDecision({ ...base, decision: "reject", note: "板块过热" });
    expect(again.id).toBe(deskDecisionId(base));
    const rows = readLedger();
    expect(rows).toHaveLength(1);
    expect(rows[0].decision).toBe("reject");
    expect(rows[0].note).toBe("板块过热");
    const saved = JSON.parse(readFileSync(process.env.DESK_LEDGER_PATH, "utf8")) as { id: string }[];
    expect(saved).toHaveLength(1);
  });
});
