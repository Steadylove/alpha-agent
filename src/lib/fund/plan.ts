import { openLots, type FundBook, type FundLot } from "./bookLogic";

/**
 * 把纪律翻成一张「明天开盘照着下单」的清单。
 *
 * 仓位规则来自回测：每笔固定投当时权益的一个比例，现金不够就不开；满仓时拿新信号的
 * RPS 跟持仓里最弱的比，明显更强才置换。
 *
 * 两条都是在现金账本口径下实测定的，判据是「三段最差」——把 2021-08 起的五年切成三段
 * 分别评分再取最差的那段，因为只有这样才逼得策略必须跨过 2022 跌段（成本 10bps）：
 *
 *   - **每笔 12.5%**。曾按仓位剖面（8%:0.66 / 10%:0.80 / 12.5%:0.68 / 15%:0.47）想改成 10%，
 *     那是错的：剖面上每一档取的是「该档配合任意吊灯的最好成绩」，10% 那个 0.80 来自吊灯 7，
 *     而这条链路的吊灯是 8。同样吊灯 8 下，10% 只有 0.57，比 12.5% 的 0.68 更差。
 *     参数之间不可分离，边际剖面不能当可加的用。
 *   - **不置换**。这一条推翻了此前的结论。旧版这里写着「置换 +20 是整套里最大的单项增益，
 *     不置换 11.3% / 置换 23.8%」，那是在一份缺了 2022 跌段的数据上算的——当时 4H/日线的
 *     Vegas 慢线没播种，整段熊市被跳过了。补齐数据重算，四个周期上置换全部是负担：
 *     日线不置换 0.68，而置换 +0/+10/+20 分别只有 0.44/0.20/0.45，换手还翻倍；
 *     4H 更极端，不置换 1.77 对置换档最好的 0.82，CAGR 从 35.9% 砍到 17.5%。
 *     原因是这套策略的钱主要来自深度回撤后的反弹，刚建仓的票 RPS 天然低，置换会在它
 *     启动之前就把它挤掉。`rotateEdge: null` 即关闭；传数字仍可开，但没有实测支持。
 */

export type FundRules = {
  /** 每笔开仓占当时权益的比例 */
  slotPct: number;
  /** 置换门槛：新信号 RPS 要高出最弱持仓多少分。null 表示不置换，满仓就放弃信号。 */
  rotateEdge: number | null;
};

export const DEFAULT_FUND_RULES: FundRules = { slotPct: 0.125, rotateEdge: null };

export type PlanPosition = {
  lot: FundLot;
  /** 最新收盘价 */
  close: number;
  /** 当前 RPS（不是开仓时的） */
  rps: number;
  /** 生效止损 = max(初始止损/保本锁, 吊灯) */
  effectiveStop: number;
  /** 收盘已跌破生效止损，次日开盘要平 */
  stopHit: boolean;
};

export type PlanSignal = {
  symbol: string;
  sigType: 1 | 2;
  rps: number;
  close: number;
};

export type PlanSell = {
  symbol: string;
  shares: number;
  reason: "stop" | "rotate";
  /** 估算回收额，按最新收盘价算；真实成交在次日开盘 */
  estProceeds: number;
  /** 止损单：触发的那条线 */
  stop?: number;
  /** 置换单：被谁顶掉的 */
  replacedBy?: string;
  rps: number;
};

export type PlanBuy = {
  symbol: string;
  sigType: 1 | 2;
  rps: number;
  /** 计划投入金额 */
  amount: number;
  /** 参考价（最新收盘），真实成交在次日开盘 */
  refPrice: number;
  /** 置换而来：顶掉了谁 */
  replaces?: string;
};

export type PlanPass = {
  symbol: string;
  rps: number;
  why: string;
};

export type FundPlan = {
  asOf: string;
  equity: number;
  cash: number;
  /** 每笔的目标金额 */
  slotAmount: number;
  sells: PlanSell[];
  buys: PlanBuy[];
  passes: PlanPass[];
  /** 执行后的预计状态 */
  projected: { positions: number; exposurePct: number; cash: number };
};

export function planDay(input: {
  asOf: string;
  positions: readonly PlanPosition[];
  signals: readonly PlanSignal[];
  book: FundBook;
  cash: number;
  equity: number;
  rules?: FundRules;
}): FundPlan {
  const rules = input.rules ?? DEFAULT_FUND_RULES;
  const slotAmount = input.equity * rules.slotPct;

  const sells: PlanSell[] = [];
  const buys: PlanBuy[] = [];
  const passes: PlanPass[] = [];

  // 止损优先：这一步不看仓位也不看信号，跌破就走
  for (const p of input.positions) {
    if (!p.stopHit) continue;
    sells.push({
      symbol: p.lot.symbol,
      shares: p.lot.shares,
      reason: "stop",
      estProceeds: p.lot.shares * p.close,
      stop: p.effectiveStop,
      rps: p.rps,
    });
  }

  // 次日开盘先卖后买，故止损腾出的钱当天就能用
  let free = input.cash + sells.reduce((s, x) => s + x.estProceeds, 0);
  const gone = new Set(sells.map((s) => s.symbol));
  const heldSymbols = new Set(openLots(input.book).map((l) => l.symbol));

  // 强的先挑：现金有限时优先给最强的信号
  const queue = [...input.signals].sort((a, b) => b.rps - a.rps);

  for (const sig of queue) {
    if (heldSymbols.has(sig.symbol)) {
      passes.push({ symbol: sig.symbol, rps: sig.rps, why: "已持仓" });
      continue;
    }

    if (free >= slotAmount) {
      buys.push({
        symbol: sig.symbol,
        sigType: sig.sigType,
        rps: sig.rps,
        amount: slotAmount,
        refPrice: sig.close,
      });
      free -= slotAmount;
      continue;
    }

    if (rules.rotateEdge == null) {
      passes.push({ symbol: sig.symbol, rps: sig.rps, why: "满仓，不置换" });
      continue;
    }

    const swappable = input.positions.filter((p) => !gone.has(p.lot.symbol));
    if (swappable.length === 0) {
      passes.push({ symbol: sig.symbol, rps: sig.rps, why: "现金不足且无可置换持仓" });
      continue;
    }

    const weakest = swappable.reduce((a, b) => (a.rps <= b.rps ? a : b));
    if (sig.rps <= weakest.rps + rules.rotateEdge) {
      passes.push({
        symbol: sig.symbol,
        rps: sig.rps,
        why:
          `满仓，未超过最弱持仓 ${weakest.lot.symbol}（RPS ${weakest.rps.toFixed(0)}）` +
          `+${rules.rotateEdge}`,
      });
      continue;
    }

    const estProceeds = weakest.lot.shares * weakest.close;
    sells.push({
      symbol: weakest.lot.symbol,
      shares: weakest.lot.shares,
      reason: "rotate",
      estProceeds,
      replacedBy: sig.symbol,
      rps: weakest.rps,
    });
    gone.add(weakest.lot.symbol);
    buys.push({
      symbol: sig.symbol,
      sigType: sig.sigType,
      rps: sig.rps,
      amount: slotAmount,
      refPrice: sig.close,
      replaces: weakest.lot.symbol,
    });
    free += estProceeds - slotAmount;
  }

  const staying = input.positions.filter((p) => !gone.has(p.lot.symbol));
  const stayingValue = staying.reduce((s, p) => s + p.lot.shares * p.close, 0);
  const boughtValue = buys.reduce((s, b) => s + b.amount, 0);

  return {
    asOf: input.asOf,
    equity: input.equity,
    cash: input.cash,
    slotAmount,
    sells,
    buys,
    passes,
    projected: {
      positions: staying.length + buys.length,
      exposurePct:
        input.equity > 0 ? ((stayingValue + boughtValue) / input.equity) * 100 : 0,
      cash: free,
    },
  };
}
