import type { DiscordPayload } from "./sendWebhook";
import { strengthLabel } from "./tvAlertCopy";

export type BookRowView = {
  symbol: string;
  floatPnlPct: number;
  entryPrice: number;
  weightPct: number;
  /** 该股相对大池的分位；未排名为 null */
  rps: number | null;
  entryDate?: string | null;
};

const signed = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`;

/** 净值从 1 起步，换成累计盈亏百分比。 */
export function bookPnlLabel(equity: number): string {
  return signed((equity - 1) * 100);
}

export function pnlLabel(pct: number): string {
  return signed(pct);
}

export function winRateLabel(pct: number | null | undefined): string {
  return pct == null ? "—" : `${pct.toFixed(0)}%`;
}

/** 开仓日到记账截止日的日历天数。 */
export function daysOpenOf(entryDate: string | null | undefined, asOf: string): number | null {
  if (!entryDate) return null;
  const a = Date.parse(`${entryDate.slice(0, 10)}T00:00:00Z`);
  const b = Date.parse(`${asOf.slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return null;
  return Math.round((b - a) / 86_400_000);
}

export function daysOpenLabel(days: number | null): string {
  return days == null ? "—" : `${days}天`;
}

/** 把净值序列抽成火花图用的点。 */
export function sparklineValues(values: readonly number[], n = 40): number[] {
  if (values.length === 0) return [];
  if (values.length <= n) return [...values];
  return Array.from({ length: n }, (_, i) => values[Math.round((i / (n - 1)) * (values.length - 1))] ?? values[0]);
}

/** 年末净值作基数；窗口从年中起步则相对 1。 */
export function ytdOfNav(points: readonly { date: string; equity: number }[]): { year: number; pct: number } | null {
  const last = points.at(-1);
  if (!last) return null;
  const year = Number(last.date.slice(0, 4));
  if (!Number.isFinite(year)) return null;
  const from = `${year}-01-01`;
  if (!points.some((p) => p.date >= from)) return null;
  const prev = [...points].reverse().find((p) => p.date < from);
  return { year, pct: (last.equity / (prev?.equity ?? 1) - 1) * 100 };
}

function rowStrength(rps: number | null): string {
  return rps != null && rps >= 1 ? strengthLabel(rps) : "—";
}

export type CashBookView = {
  asOf: string;
  /** 记账起始日 YYYY-MM-DD */
  since: string;
  label: string;
  rows: readonly BookRowView[];
  equity?: number;
  ytdPct?: number;
  ytdYear?: number;
  exposurePct: number;
  dd?: number;
  mar?: number;
  avgHoldings?: number;
  avgExposure?: number;
  winRatePct?: number | null;
  /** 净值曲线，给卡片火花图 */
  curve?: readonly number[];
  /** 同窗口相对 QQQ 超额，百分点 */
  vsQqqPct?: number | null;
};

export function renderCashBook(input: CashBookView): DiscordPayload {
  const lines =
    input.rows.length === 0
      ? "空仓"
      : input.rows
          .map((h) => {
            return `\`${h.symbol}\`  ${signed(h.floatPnlPct)}  开 ${h.entryPrice.toFixed(2)}  仓 ${h.weightPct.toFixed(1)}%  ${rowStrength(h.rps)}`;
          })
          .join("\n");

  const cashPct = Math.max(0, 100 - input.exposurePct);
  const exposureLabel = input.avgExposure != null ? `${input.avgExposure.toFixed(0)}%` : `${input.exposurePct.toFixed(0)}%`;
  const fields = [
    { name: `持仓 ${input.rows.length} 只`, value: lines.slice(0, 1024) },
    ...(input.equity != null
      ? [{ name: "累计盈利", value: `\`${bookPnlLabel(input.equity)}\``, inline: true }]
      : []),
    ...(input.dd != null ? [{ name: "回撤", value: `\`${input.dd.toFixed(0)}%\``, inline: true }] : []),
    ...(input.mar != null ? [{ name: "MAR", value: `\`${input.mar.toFixed(2)}\``, inline: true }] : []),
    ...(input.avgHoldings != null
      ? [{ name: "均持", value: `\`${input.avgHoldings.toFixed(1)}\``, inline: true }]
      : []),
    { name: "敞口", value: `\`${exposureLabel}\``, inline: true },
    ...(input.winRatePct !== undefined
      ? [{ name: "胜率", value: `\`${winRateLabel(input.winRatePct)}\``, inline: true }]
      : []),
    ...(input.ytdPct != null
      ? [
          {
            name: input.ytdYear != null ? `${input.ytdYear} YTD` : "YTD",
            value: `\`${pnlLabel(input.ytdPct)}\``,
            inline: true,
          },
        ]
      : []),
    { name: "现金", value: `\`${cashPct.toFixed(0)}%\``, inline: true },
  ];

  const headline = [
    `📒 **${input.label} 现金账本**`,
    `记账自 ${input.since.slice(0, 10)}`,
    `截至 ${input.asOf}`,
    input.equity != null ? `累计 ${bookPnlLabel(input.equity)}` : null,
    input.dd != null ? `回撤 ${input.dd.toFixed(0)}%` : null,
    input.mar != null ? `MAR ${input.mar.toFixed(2)}` : null,
    input.avgHoldings != null ? `均持 ${input.avgHoldings.toFixed(1)}` : null,
    `敞口 ${exposureLabel}`,
    input.winRatePct !== undefined ? `胜率 ${winRateLabel(input.winRatePct)}` : null,
  ]
    .filter((x): x is string => x != null)
    .join("  ");

  return {
    content: headline,
    embeds: [{ color: 0x2563eb, fields }],
  };
}
