import { NextResponse } from "next/server";

import { recordBuy, recordCashFlow, recordSell } from "@/lib/fund/book";
import type { FundExitReason } from "@/lib/fund/bookLogic";

/**
 * 记一笔真实成交，或一笔注资/提取。
 *
 * 清单只是建议，成交价和金额得回填真实的——账本要能跟券商对上，
 * 否则下一笔的开仓金额（按权益算）就是错的。
 */

export const dynamic = "force-dynamic";

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : Number.NaN;
};

export async function POST(request: Request) {
  let body: Record<string, unknown> = {};
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "无效 JSON" }, { status: 400 });
  }

  const kind = body.kind;
  const date = typeof body.date === "string" && body.date ? body.date : new Date().toISOString().slice(0, 10);

  try {
    if (kind === "cash") {
      const amount = num(body.amount);
      if (Number.isNaN(amount) || amount === 0) {
        return NextResponse.json({ error: "amount 必须是非零数字" }, { status: 400 });
      }
      const book = recordCashFlow({
        date,
        amount,
        note: typeof body.note === "string" ? body.note : undefined,
      });
      return NextResponse.json({ ok: true, cashFlows: book.cashFlows.length });
    }

    const symbol = typeof body.symbol === "string" ? body.symbol : "";
    if (!symbol.trim()) return NextResponse.json({ error: "symbol 必填" }, { status: 400 });
    const price = num(body.price);
    if (Number.isNaN(price)) return NextResponse.json({ error: "price 必须是数字" }, { status: 400 });

    if (kind === "buy") {
      const cost = num(body.cost);
      if (Number.isNaN(cost)) return NextResponse.json({ error: "cost 必须是数字" }, { status: 400 });
      const lot = recordBuy({
        symbol,
        timeframe: typeof body.timeframe === "string" ? body.timeframe : "1d",
        sigType: body.sigType === 2 ? 2 : 1,
        date,
        price,
        cost,
        rps: num(body.rps) || 0,
        note: typeof body.note === "string" ? body.note : undefined,
      });
      return NextResponse.json({ ok: true, lot });
    }

    if (kind === "sell") {
      const proceeds = num(body.proceeds);
      if (Number.isNaN(proceeds)) {
        return NextResponse.json({ error: "proceeds 必须是数字" }, { status: 400 });
      }
      const reasonRaw = body.reason;
      const reason: FundExitReason =
        reasonRaw === "stop" || reasonRaw === "rotate" ? reasonRaw : "manual";
      const lot = recordSell({
        symbol,
        date,
        price,
        proceeds,
        reason,
        note: typeof body.note === "string" ? body.note : undefined,
      });
      return NextResponse.json({ ok: true, lot });
    }

    return NextResponse.json({ error: "kind 必须是 buy / sell / cash" }, { status: 400 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "记账失败" },
      { status: 400 },
    );
  }
}
