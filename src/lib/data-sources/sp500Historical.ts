/**
 * 标普 500 的时点成分股（point-in-time membership）。
 *
 * 数据来自公开仓库 fja05680/sp500 维护的成分快照：每个成分变更日一行，
 * 内容是当日的完整名单，覆盖 1996-01 至今。
 *
 * 为什么必须用时点成分：拿今天的名单去跑 2010 年的回测，等于事先知道
 * 哪些公司活到了今天并且长成了大市值，这是回测虚高的首要来源。按当日
 * 成分资格入池能消掉这一层——成分资格由当时的规则决定，不含后见之明。
 *
 * 已知残留偏差：本项目只回填仍在交易的标的（见 `importIndexMembership`），
 * 退市标的拿不到价格。被收购者多以溢价离场（排除后偏低），破产者清零
 * （排除后偏高），二者部分相抵，净偏差符号不定。
 */

const SNAPSHOT_URL =
  "https://raw.githubusercontent.com/fja05680/sp500/master/S%26P%20500%20Historical%20Components%20%26%20Changes%20(Updated).csv";

/** 一段连续的成分资格区间；`end` 为 null 表示仍在指数内。 */
export type MembershipInterval = {
  ticker: string;
  start: string;
  end: string | null;
};

type Snapshot = { date: string; tickers: string[] };

/**
 * 解析 `date,"T1,T2,..."` 两列 CSV。
 *
 * 名单列整体被一对引号包住且内部含逗号，不能按逗号直接切。
 */
function parseSnapshots(csv: string): Snapshot[] {
  const out: Snapshot[] = [];

  for (const line of csv.trim().split("\n").slice(1)) {
    const comma = line.indexOf(",");
    if (comma < 0) continue;

    const date = line.slice(0, comma).trim();
    const raw = line.slice(comma + 1).trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;

    const tickers = raw
      .replace(/^"|"$/g, "")
      .split(",")
      .map((t) => t.trim())
      // BRK.B / BF.B 等在 Yahoo 是 BRK-B
      .map((t) => t.replace(/\./g, "-"))
      .filter(Boolean);

    if (tickers.length > 0) out.push({ date, tickers });
  }

  return out.sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * 把逐日快照压成成分资格区间。
 *
 * 同一标的可能多次进出指数，因此一个 ticker 会产出多段区间。区间右端取
 * **该标的最后一次出现的快照日**：更晚的快照已不含它，说明它在这两个
 * 快照之间的某个时点离开了，用最后出现日作为结束是可得的最紧上界。
 */
export function deriveIntervals(snapshots: Snapshot[]): MembershipInterval[] {
  /** ticker -> 出现过它的快照序号列表 */
  const appearances = new Map<string, number[]>();
  snapshots.forEach((snap, i) => {
    for (const ticker of snap.tickers) {
      const list = appearances.get(ticker);
      if (list) list.push(i);
      else appearances.set(ticker, [i]);
    }
  });

  const lastIndex = snapshots.length - 1;
  const out: MembershipInterval[] = [];

  for (const [ticker, indexes] of appearances) {
    let runStart = indexes[0];
    let prev = indexes[0];

    for (const i of indexes.slice(1)) {
      if (i === prev + 1) {
        prev = i;
        continue;
      }
      // 出现了断档，先收掉上一段
      out.push({
        ticker,
        start: snapshots[runStart].date,
        end: snapshots[prev].date,
      });
      runStart = i;
      prev = i;
    }

    out.push({
      ticker,
      start: snapshots[runStart].date,
      // 仍在最新快照里 → 视为在指数内
      end: prev === lastIndex ? null : snapshots[prev].date,
    });
  }

  return out.sort((a, b) => a.ticker.localeCompare(b.ticker) || a.start.localeCompare(b.start));
}

export async function fetchSp500Membership(): Promise<{
  intervals: MembershipInterval[];
  snapshotCount: number;
  firstDate: string;
  lastDate: string;
}> {
  const res = await fetch(SNAPSHOT_URL);
  if (!res.ok) throw new Error(`成分快照拉取失败: ${res.status}`);

  const snapshots = parseSnapshots(await res.text());
  if (snapshots.length === 0) throw new Error("成分快照解析结果为空");

  return {
    intervals: deriveIntervals(snapshots),
    snapshotCount: snapshots.length,
    firstDate: snapshots[0].date,
    lastDate: snapshots[snapshots.length - 1].date,
  };
}
