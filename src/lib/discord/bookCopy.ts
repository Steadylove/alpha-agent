import type { DiscordPayload } from "./sendWebhook";
import { strengthLabel } from "./tvAlertCopy";

export type BookRowView = {
  symbol: string;
  floatPnlPct: number;
  entryPrice: number;
  weightPct: number;
  /** 该股相对大池的分位；未排名为 null */
  rps: number | null;
};

const signed = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`;

/** 净值从 1 起步，换成累计盈亏百分比。 */
export function bookPnlLabel(equity: number): string {
  return signed((equity - 1) * 100);
}

function rowStrength(rps: number | null): string {
  return rps != null && rps >= 1 ? strengthLabel(rps) : "—";
}

export function renderCashBook(input: {
  asOf: string;
  /** 记账起始日 YYYY-MM-DD */
  since: string;
  label: string;
  rows: readonly BookRowView[];
  equity?: number;
  exposurePct: number;
}): DiscordPayload {
  const lines =
    input.rows.length === 0
      ? "空仓"
      : input.rows
          .map((h) => {
            return `\`${h.symbol}\`  ${signed(h.floatPnlPct)}  开 ${h.entryPrice.toFixed(2)}  仓 ${h.weightPct.toFixed(1)}%  ${rowStrength(h.rps)}`;
          })
          .join("\n");

  const cashPct = Math.max(0, 100 - input.exposurePct);
  const fields = [
    { name: `持仓 ${input.rows.length} 只`, value: lines.slice(0, 1024) },
    { name: "敞口", value: `\`${input.exposurePct.toFixed(0)}%\``, inline: true },
    { name: "现金", value: `\`${cashPct.toFixed(0)}%\``, inline: true },
  ];
  if (input.equity != null) {
    fields.splice(1, 0, { name: "累计盈利", value: `\`${bookPnlLabel(input.equity)}\``, inline: true });
  }

  return {
    content: `📒 **${input.label} 现金账本**  记账自 ${input.since.slice(0, 10)}  截至 ${input.asOf}`,
    embeds: [{ color: 0x2563eb, fields }],
  };
}
