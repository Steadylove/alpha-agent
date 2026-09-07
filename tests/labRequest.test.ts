import { describe, expect, it } from "vitest";

import { openTradeRow } from "@/lib/backtest/labRequest";
import type { TradeDay } from "@/lib/scoring/rotationTrade";

const hold = (over: Partial<TradeDay> = {}): TradeDay => ({
  sigType: 1,
  entryPrice: 100,
  stopLevel: 90,
  trailLevel: 90,
  effectiveStop: 90,
  targetLevel: null,
  maxPnlPct: 10,
  floatPnlPct: 10,
  breakevenLocked: false,
  riskPct: 4,
  entryRps: 40,
  entryDate: "2026-09-04T13:30",
  entered: false,
  exited: false,
  ...over,
});

describe("openTradeRow", () => {
  it("空仓不附", () => {
    expect(
      openTradeRow(
        [{ ...hold(), sigType: 0, entryPrice: null, entryDate: null, floatPnlPct: 0 }],
        "2099-01-01",
        "ALAB",
      ),
    ).toBeNull();
  });

  it("未平仓带浮盈", () => {
    const row = openTradeRow(
      [
        hold({ entered: true, floatPnlPct: 0 }),
        hold({ floatPnlPct: 12.5 }),
      ],
      "2099-01-01",
      "ALAB",
    );
    expect(row).toMatchObject({
      symbol: "ALAB",
      entryDate: "2026-09-04T13:30",
      pnlPct: 12.5,
      barsHeld: 2,
      exitReason: "open",
      open: true,
      exitDate: null,
    });
  });
});
