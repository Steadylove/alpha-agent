import { Card } from "@/components/Card";
import { StockSignalChart } from "@/components/StockSignalChart";
import { getStockSignalChart } from "@/lib/dashboard/stockSignalChart";
import { ROTATION_UNIVERSE } from "@/lib/scoring/rotationUniverse";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";

/** 数据每日一更，按 ISR 缓存；见首页注释。 */
export const revalidate = 300;

/**
 * 预渲染全部 40 只标的。
 *
 * 不列举的话这条路由会退化成每次请求重算：信号与 Vegas 隧道都要在全历史
 * （5000+ 根）上推进才正确，单页服务端渲染要 2.6 秒。
 */
export function generateStaticParams() {
  return ROTATION_UNIVERSE.map((t) => ({ symbol: t.symbol }));
}

const money = (v: number) => `$${v.toFixed(2)}`;
const pct = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`;

const SLOT_LABEL = { buy1: "❤️ 一买", buy2: "⭐️ 二买" } as const;

/**
 * Pine 源码把第二条线叫「止盈线」，但它的初值是开仓价 − 5.5×ATR，在硬止损
 * （− 4×ATR）**下方**，跟着最高价上抬、只升不降——本质是一条更宽的移动止损，
 * 跟止盈没有关系。界面按实际语义命名，避免读成「止盈比止损还低」。
 */
const REASON_LABEL = { stop_loss: "硬止损", trail: "移动止损" } as const;

function Binding() {
  return (
    <span className="ml-1.5 rounded bg-zinc-700/60 px-1.5 py-0.5 align-middle text-[10px] font-sans text-zinc-200">
      当前生效
    </span>
  );
}

export default async function StockSignalPage({
  params,
}: {
  params: Promise<{ symbol: string }>;
}) {
  const { symbol } = await params;
  const data = await getStockSignalChart(symbol);
  if (!data) notFound();

  const wins = data.trades.filter((t) => t.pnlPct > 0).length;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-zinc-50">{data.symbol}</h1>
          <p className="text-sm text-zinc-500">{data.name}</p>
        </div>
        <Link
          href="/depth"
          className="inline-flex items-center gap-2 text-sm text-zinc-400 transition-colors hover:text-zinc-50"
        >
          <ArrowLeft className="h-4 w-4" /> 深度面板
        </Link>
      </div>

      {data.openSlots.length > 0 ? (
        <Card title="当前持仓">
          <div className="space-y-3">
            {data.openSlots.map((s) => {
              // 两条防线任一被跌破就离场，所以真正约束价格的是更高的那条
              const stopBinds = s.stop >= s.trail;
              return (
                <div key={s.slot} className="flex flex-wrap items-baseline gap-x-6 gap-y-1 text-sm">
                  <span className="font-semibold text-zinc-200">{SLOT_LABEL[s.slot]}</span>
                  <span className="font-mono text-zinc-400">成本 {money(s.entryPrice)}</span>
                  <span
                    className="font-mono"
                    style={{ color: s.pnlPct >= 0 ? "#089981" : "#f23645" }}
                  >
                    浮盈 {pct(s.pnlPct)}
                  </span>
                  <span className="font-mono text-red-400">
                    硬止损 {money(s.stop)}
                    {stopBinds ? <Binding /> : null}
                  </span>
                  <span className="font-mono text-purple-400">
                    移动止损 {money(s.trail)}
                    {stopBinds ? null : <Binding />}
                  </span>
                </div>
              );
            })}
          </div>
          <p className="mt-3 text-xs leading-relaxed text-zinc-500">
            两条防线是并行的，跌破任意一条即离场，因此当前真正生效的是更高的那条。
            移动止损起点比硬止损更低（5.5 倍波动幅度 vs 4 倍），只有在价格走出足够涨幅后才会反超。
          </p>
        </Card>
      ) : null}

      <StockSignalChart data={data} />

      <Card
        title={
          <div className="flex items-baseline gap-3">
            <span>窗口内已完成交易</span>
            <span className="text-xs font-normal text-zinc-500">
              {data.trades.length} 笔 · {wins} 胜
            </span>
          </div>
        }
      >
        {data.trades.length === 0 ? (
          <p className="text-sm text-zinc-500">该窗口内没有完成的交易。</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-zinc-500">
                  <th className="pb-2 pr-3 text-left font-normal">仓位</th>
                  <th className="pb-2 pr-3 text-left font-normal">建仓</th>
                  <th className="pb-2 pr-3 text-right font-normal">建仓价</th>
                  <th className="pb-2 pr-3 text-left font-normal">离场</th>
                  <th className="pb-2 pr-3 text-right font-normal">离场价</th>
                  <th className="pb-2 pr-3 text-right font-normal">盈亏</th>
                  <th className="pb-2 pr-3 text-right font-normal">持有</th>
                  <th className="pb-2 text-left font-normal">离场原因</th>
                </tr>
              </thead>
              <tbody>
                {data.trades.map((t) => (
                  <tr key={`${t.slot}-${t.entryDate}`} className="border-t border-zinc-800/60">
                    <td className="py-2 pr-3 text-xs">{SLOT_LABEL[t.slot]}</td>
                    <td className="py-2 pr-3 font-mono text-xs text-zinc-400">{t.entryDate}</td>
                    <td className="py-2 pr-3 text-right font-mono text-zinc-300">
                      {money(t.entryPrice)}
                    </td>
                    <td className="py-2 pr-3 font-mono text-xs text-zinc-400">{t.exitDate}</td>
                    <td className="py-2 pr-3 text-right font-mono text-zinc-300">
                      {money(t.exitPrice)}
                    </td>
                    <td
                      className="py-2 pr-3 text-right font-mono"
                      style={{ color: t.pnlPct >= 0 ? "#089981" : "#f23645" }}
                    >
                      {pct(t.pnlPct)}
                    </td>
                    <td className="py-2 pr-3 text-right font-mono text-zinc-500">
                      {t.barsHeld} 天
                    </td>
                    <td className="py-2 text-xs text-zinc-400">{REASON_LABEL[t.reason]}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
