import { NextResponse } from "next/server";

import { frozenDeskConfig } from "@/lib/backtest/deskScan";
import { getPreparedUniverse } from "@/lib/backtest/load";
import { parseSmallFundPoolId } from "@/lib/backtest/smallFundPools";
import { cashOf, equityOf, openLots, readFundBook } from "@/lib/fund/book";
import { DEFAULT_FUND_RULES, planDay } from "@/lib/fund/plan";
import { scanSignals, trackPositions } from "@/lib/fund/track";

/**
 * 今日清单：账本 + 最新一根的信号 → 明天开盘照着下的单。
 *
 * 目前只跑日线，但这个限制的原始理由已经不成立了：此前记的是「4H 回撤 35~47%，
 * 对权重法的 21%」，那组数字来自 4H 数据只到 2021 的年代——Vegas 慢线没播种，
 * 策略被迫空仓到 2022-05，整段熊市缺席。补数据重搜后 4H 是 CAGR 35.9% / 回撤 17%，
 * 回撤比日线的 21% 还小，三段最差 1.77 对日线 0.80。
 *
 * 换到 4H 不只是改这里的 timeframe：入场限定在当日最后一根 4H 收盘（entryWindow
 * dayClose），账本和信号扫描都得按盘中根走。属于单独一件事，没做。
 */

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const poolId = parseSmallFundPoolId(url.searchParams.get("pool"));
  const slotPct = Number(url.searchParams.get("slotPct") ?? DEFAULT_FUND_RULES.slotPct);
  // 默认是 null（不置换），不能走 Number()——Number(null) 是 0，正好是实测最差的那一档。
  const rotateRaw = url.searchParams.get("rotateEdge");
  const rotateEdge =
    rotateRaw == null || rotateRaw === ""
      ? DEFAULT_FUND_RULES.rotateEdge
      : rotateRaw === "off"
        ? null
        : Number(rotateRaw);

  try {
    const universe = await getPreparedUniverse("SMALLFUND", "1d", poolId);
    const asOf = universe.axis.at(-1) ?? "";
    const config = frozenDeskConfig("1d", asOf);

    const book = readFundBook();
    const lots = openLots(book);
    const { positions, unresolved } = trackPositions(universe, config, lots, asOf);
    const signals = scanSignals(universe, config, asOf);

    const marks = new Map(positions.map((p) => [p.lot.symbol, p.close]));
    const cash = cashOf(book);
    const equity = equityOf(book, marks);

    const plan = planDay({
      asOf,
      positions,
      signals,
      book,
      cash,
      equity,
      rules: {
        slotPct: Number.isFinite(slotPct) ? Math.min(1, Math.max(0.01, slotPct)) : DEFAULT_FUND_RULES.slotPct,
        rotateEdge:
          rotateEdge != null && Number.isFinite(rotateEdge)
            ? Math.max(0, rotateEdge)
            : DEFAULT_FUND_RULES.rotateEdge,
      },
    });

    return NextResponse.json({
      asOf,
      poolId,
      plan,
      positions: positions.map((p) => ({
        symbol: p.lot.symbol,
        entryDate: p.lot.entryDate,
        entryPrice: p.lot.entryPrice,
        shares: p.lot.shares,
        cost: p.lot.cost,
        close: p.close,
        value: p.lot.shares * p.close,
        floatPnlPct: ((p.close - p.lot.entryPrice) / p.lot.entryPrice) * 100,
        rps: p.rps,
        entryRps: p.lot.entryRps,
        effectiveStop: p.effectiveStop,
        stopDistancePct: ((p.close - p.effectiveStop) / p.close) * 100,
        stopHit: p.stopHit,
      })),
      unresolved,
      signalCount: signals.length,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "生成清单失败" },
      { status: 500 },
    );
  }
}
