import { sparklineValues } from "@/lib/discord/bookCopy";
import type { LookbackPoint, LookbackView } from "./lookbackLogic";
import type { LiveBookOk } from "./liveBooksLogic";
import type { RotateCheckpoint } from "./rotate";

const agrees = (a: number, b: number) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= 1e-8 * Math.max(1, Math.abs(a));

/** 从已记账净值补回旧缓存省略的日期，不重算历史交易或覆盖已有净值。 */
export function restoreBookCurve(view: LookbackView, checkpoint: RotateCheckpoint): LookbackView {
  const fail = () => { throw new Error("账本曲线与已记账净值不一致，停止生成卡片，请检查保存的账本"); };
  const from = view.since.slice(0, 10), to = view.asOf.slice(0, 10);
  const daily = [...checkpoint.dailyEquity].sort((a, b) => a.date.localeCompare(b.date));
  if (checkpoint.asOf !== view.asOf || !agrees(checkpoint.lastEq, view.equity) || !daily.length ||
    daily.at(-1)!.date !== to || !agrees(daily.at(-1)!.v, view.equity)) fail();
  const saved = new Map<string, number>();
  for (const p of daily) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(p.date) || p.date < from || p.date > to ||
      !Number.isFinite(p.v) || p.v <= 0 || saved.has(p.date)) fail();
    saved.set(p.date, p.v);
  }
  const existing = new Map<string, LookbackPoint>();
  for (const p of view.curve) {
    if (existing.has(p.date) || !saved.has(p.date) || !agrees(p.equity, saved.get(p.date)!)) fail();
    existing.set(p.date, p);
  }
  if (view.curve.length === daily.length && view.curve.every((p, i) => p.date === daily[i].date)) return view;

  const curve = daily.map(({ date, v }): LookbackPoint => {
    const old = existing.get(date);
    if (old) return old;
    const fills = view.fills.filter((f) => f.date.slice(0, 10) === date);
    return {
      date, equity: v,
      // 恢复点没有每日持仓明细，沿用旧图表的空占位；只展示可确认的净值与成交。
      exposurePct: date === to ? view.exposurePct : 0,
      rows: date === to ? view.rows : [],
      buys: [...new Set(fills.filter((f) => f.side === "buy").map((f) => f.symbol))],
      sells: [...new Set(fills.filter((f) => f.side === "sell").map((f) => f.symbol))],
      misses: [],
    };
  });
  return { ...view, curve };
}

/** 读取、保存和日推共用同一份曲线；无恢复状态的旧版仍保留原始采样图。 */
export function withBookCurve(book: LiveBookOk): LiveBookOk {
  if (!book.checkpoint) return book;
  const view = restoreBookCurve(book.view, book.checkpoint);
  return { ...book, view, sparkline: sparklineValues(view.curve.map((p) => p.equity)) };
}
