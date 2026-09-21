import type { LiveBookCache } from "@/lib/fund/liveBooksLogic";
import { TWO_HOUR_VERSION } from "@/lib/backtest/twoHourVersion";
import type { ReviewAccount, ReviewTf } from "./types";
import { pct, positive } from "./market";

export function reviewAccounts(
  cache: LiveBookCache | null,
  date: string,
  previousDate: string | null,
  prior: ReviewAccount[] = [],
  sessions: string[] = [],
): ReviewAccount[] {
  return (["2h", "4h"] as ReviewTf[]).map((tf) => {
    const book = cache?.books.find(
      (b) =>
        b.tf === tf &&
        (tf !== "2h" || cache.twoHourVersion === TWO_HOUR_VERSION),
    );
    const view = book?.view,
      curve = view?.curve.filter((p) => p.date <= date) ?? [];
    const today = curve.find((p) => p.date === date),
      previous = curve.find((p) => p.date === previousDate);
    const monthStart = sessions
      .filter((d) => d < `${date.slice(0, 7)}-01`)
      .at(-1);
    const monthBase = monthStart
      ? curve.find((p) => p.date === monthStart)
      : undefined;
    const current = !!(today && view?.asOf.slice(0, 10) === date);
    const cp =
      current && book?.checkpoint?.asOf === view!.asOf ? book.checkpoint : null;
    const positions = current
      ? view!.rows.map((r) => ({
          symbol: r.symbol,
          weight: r.weightPct,
          shares: cp?.slots[r.symbol]?.shares ?? null,
          mark: cp?.legs[r.symbol]?.lastClose ?? null,
          entryDate: r.entryDate ?? null,
        }))
      : [];
    const daily =
      positive(today?.equity) && positive(previous?.equity)
        ? pct(today.equity, previous.equity)
        : null;
    const traded = [
      ...new Set(
        view?.fills
          .filter((f) => f.date.slice(0, 10) === date)
          .map((f) => f.symbol) ?? [],
      ),
    ];
    const old = prior.find(
      (b) => b.tf === tf && b.asOf?.slice(0, 10) === previousDate,
    );
    const attribution: ReviewAccount["attribution"] = [];
    if (
      cp &&
      old &&
      positive(previous?.equity) &&
      positive(old.equity) &&
      Math.abs(old.equity - previous.equity) < 1e-8
    )
      for (const p of positions) {
        const before = old.positions.find(
          (s) =>
            s.symbol === p.symbol &&
            s.entryDate === p.entryDate &&
            s.shares === p.shares,
        );
        if (
          !traded.includes(p.symbol) &&
          before &&
          positive(p.shares) &&
          positive(p.mark) &&
          positive(before.mark)
        ) {
          attribution.push({
            symbol: p.symbol,
            contribution:
              ((p.shares * (p.mark - before.mark)) / previous.equity) * 100,
          });
        }
      }
    attribution.sort(
      (a, b) => Math.abs(b.contribution) - Math.abs(a.contribution),
    );
    return {
      tf,
      asOf: view?.asOf ?? null,
      computedAt: cache?.computedAt ?? null,
      equity: today?.equity ?? null,
      daily,
      monthly:
        positive(today?.equity) && positive(monthBase?.equity)
          ? pct(today.equity, monthBase.equity)
          : null,
      holdings: current ? positions.length : null,
      cashPct: current ? 100 - view!.exposurePct : null,
      maxWeight: current
        ? Math.max(0, ...positions.map((p) => p.weight))
        : null,
      positions,
      traded,
      curve: curve.slice(-63).map((p) => ({ date: p.date, equity: p.equity })),
      attribution,
      residual:
        daily != null && attribution.length
          ? daily - attribution.reduce((a, b) => a + b.contribution, 0)
          : null,
      note: !current
        ? "对应交易日的账户快照缺失；未套用当前持仓。"
        : !attribution.length
          ? "尚无相邻交易日持仓快照，暂不能解释单股贡献。"
          : "贡献仅核算全天持有且股数未变的仓位；差额包含当日交易及其他未归因部分。",
    };
  });
}
