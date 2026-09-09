/**
 * 4H 每天最多两根（美东 9:30 / 13:30）。
 * 2H 多出来的那根是 11:30 ET：夏令 15:30 UTC，冬令 16:30 UTC。
 * 文件名是 4h、里面却是 2H 时，账本会按 4H 规则在 2H 上跑，必须当场炸掉。
 */

const TWO_HOUR_MIDDAY = new Set(["15:30", "16:30"]);

function clockOf(iso: string): string | null {
  const t = iso.indexOf("T");
  if (t < 0 || iso.length < t + 6) return null;
  return iso.slice(t + 1, t + 6);
}

export function assertFourHourShape(panels: readonly { ticker: string; dates: readonly string[] }[]): void {
  for (const panel of panels) {
    const perDay = new Map<string, number>();
    for (const date of panel.dates) {
      const clock = clockOf(date);
      if (clock && TWO_HOUR_MIDDAY.has(clock)) {
        throw new Error(`4H 行情混进了 2H 棒：${panel.ticker} ${date}`);
      }
      const day = date.slice(0, 10);
      const n = (perDay.get(day) ?? 0) + 1;
      if (n >= 3) {
        throw new Error(`4H 行情单日超过 2 根（像 2H）：${panel.ticker} ${day}`);
      }
      perDay.set(day, n);
    }
  }
}
