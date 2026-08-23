/**
 * 纳斯达克 100 的时点成分股（point-in-time membership）。
 *
 * 数据来自公开仓库 unliftedq/index-constitution，格式与标普那份不同：
 * 它直接给出 `symbol,name,opt-in,opt-out` 的区间，不需要从逐日快照推导，
 * 因此本模块没有 `deriveIntervals` 的对应物。
 *
 * 已验证为真时点数据而非当前成分快照，抽查对照公开事实：
 *   - NFLX  2010-12 入指、2012-12 被剔除、2013-06 重新纳入（三段）
 *   - YHOO  2017-06 退出（Verizon 收购完成）
 *   - PTON  2020-12 入、2022-01 出
 * 幸存者偏差的数据集不可能记录到 NFLX 那次剔除与回归。
 *
 * 覆盖范围：276 个 ticker、313 段区间，其中 211 段已结束。
 * 起点锚定在 2006-01-01（109 段以此为 opt-in），这是数据集的起始快照日，
 * **不是真实入指日**——早于此的入指时间不可知，故 2006 年附近的区间左端不可信。
 * 我们的回测窗口从 2007-09 起，受此影响的只有边界附近。
 */

import type { MembershipInterval } from "./sp500Historical";

const HISTORY_URL =
  "https://raw.githubusercontent.com/unliftedq/index-constitution/main/history/nasdaq100.csv";

/** 数据集的起始锚点，非真实入指日。 */
export const NDX_ANCHOR_DATE = "2006-01-01";

const ISO = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 解析 `symbol,name,opt-in,opt-out` 四列 CSV。
 *
 * 公司名里可能含逗号（如 "Cintas Corporation, Inc."），所以从**末尾**取
 * 两个日期字段、从开头取 symbol，中间一概当作名称丢弃。
 */
export function parseNdxIntervals(csv: string): MembershipInterval[] {
  const out: MembershipInterval[] = [];

  for (const line of csv.replace(/^\uFEFF/, "").trim().split("\n").slice(1)) {
    const cells = line.split(",").map((c) => c.trim());
    if (cells.length < 4) continue;

    const ticker = cells[0].replace(/\./g, "-");
    const start = cells[cells.length - 2];
    const rawEnd = cells[cells.length - 1];
    if (!ticker || !ISO.test(start)) continue;

    out.push({ ticker, start, end: ISO.test(rawEnd) ? rawEnd : null });
  }

  return out.sort((a, b) => a.ticker.localeCompare(b.ticker) || a.start.localeCompare(b.start));
}

export async function fetchNasdaq100Membership(): Promise<{
  intervals: MembershipInterval[];
  firstDate: string;
  lastDate: string;
}> {
  const res = await fetch(HISTORY_URL);
  if (!res.ok) throw new Error(`纳斯达克 100 成分拉取失败: ${res.status}`);

  const intervals = parseNdxIntervals(await res.text());
  if (intervals.length === 0) throw new Error("纳斯达克 100 成分解析结果为空");

  const starts = intervals.map((i) => i.start).sort();
  const ends = intervals.map((i) => i.end).filter((e): e is string => e != null).sort();

  return {
    intervals,
    firstDate: starts[0],
    lastDate: ends[ends.length - 1] ?? starts[starts.length - 1],
  };
}
