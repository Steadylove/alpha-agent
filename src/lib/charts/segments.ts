import type { Time } from "lightweight-charts";

/**
 * 把一条含空洞的序列切成若干连续持仓段。
 *
 * 不能靠 whitespace（`{ time }` 无值点）来断线：lightweight-charts 的 whitespace
 * 只是占住时间槽，折线渲染时会被跳过，相邻两个有值点仍然直连。空仓期长达数年时
 * 就会拉出一条横跨全图的斜线。每段单独建一条 series 才能真正断开。
 */
export function segments(points: { time: string; value: number | null }[]) {
  const out: { time: Time; value: number }[][] = [];
  let cur: { time: Time; value: number }[] = [];
  for (const p of points) {
    if (p.value == null) {
      if (cur.length > 0) out.push(cur);
      cur = [];
    } else {
      cur.push({ time: p.time as Time, value: p.value });
    }
  }
  if (cur.length > 0) out.push(cur);
  return out;
}
