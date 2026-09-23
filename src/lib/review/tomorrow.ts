import type { DailyReview, ReviewTf } from "./types";
import {
  optionsStructure,
  FLIP_LABEL,
  GAMMA_LABEL,
  WALL_LABEL,
} from "@/lib/options/structure";
import { STRENGTH_LABELS, SIGNAL_LABELS } from "./followup";
import { quoteTimestamp } from "@/lib/options/signalContext";

export const TOMORROW_VERSION = "tomorrow-v1" as const;
// Attention filters, not trading thresholds or optimized return forecasts.
export const TOMORROW_RULES = {
  maxItems: 5,
  newSignalScore: 70,
  sectorRankMove: 20,
  sectorRelativeDay: 0.5,
  wallMovePct: 0.3,
  nominalRateBp: 10,
  realRateBp: 10,
  dollarPct: 0.8,
  oilPct: 3,
  goldPct: 2,
  bitcoinPct: 5,
  vixPct: 8,
} as const;
export type WatchEvent = {
  id: string;
  domain: "market" | "options" | "sectors" | "accounts" | "signals" | "macro";
  group: "market" | "portfolio";
  symbols: string[];
  tf?: ReviewTf;
  title: string;
  evidence: string;
  focus: string;
  source: "market" | "options" | "sectors" | "accounts" | "signals" | "journal";
  priority: number;
};
export type TomorrowObservation = {
  eventId: string;
  title: string;
  text: string;
  status: "observed" | "missing";
};
export type TomorrowMap = {
  version: typeof TOMORROW_VERSION;
  date: string;
  targetDate: string | null;
  basis: "published" | "reconstructed";
  publishedAt: string;
  updatedAt: string;
  revision: number;
  events: WatchEvent[];
  candidates?: WatchEvent[];
  candidateCount: number;
  notes: string[];
  observations: TomorrowObservation[];
  history: { at: string; reason: string; events: WatchEvent[] }[];
};
const n = (x: number) =>
  Number(x.toFixed(2)).toLocaleString("en-US", { maximumFractionDigits: 2 });
const finite = (x: unknown): x is number =>
  typeof x === "number" && Number.isFinite(x);
const ratio = (a: number, b: number) => (b > 0 ? 100 * (a / b - 1) : 0);
const sameAccount = (r: DailyReview, tf: ReviewTf) =>
  r.accounts.find(
    (a) => a.tf === tf && a.asOf?.slice(0, 10) === r.date && a.holdings != null,
  );

/** Macro supplementation calls this independently; it cannot recalculate non-macro events. */
export function macroWatchEvents(r: DailyReview): WatchEvent[] {
  const rows = r.market.macro?.rows ?? [];
  const thresholds: Record<string, number> = {
    DGS10: TOMORROW_RULES.nominalRateBp,
    DGS2: TOMORROW_RULES.nominalRateBp,
    DFII10: TOMORROW_RULES.realRateBp,
    DXY: TOMORROW_RULES.dollarPct,
    WTI: TOMORROW_RULES.oilPct,
    GOLD: TOMORROW_RULES.goldPct,
    BTC: TOMORROW_RULES.bitcoinPct,
  };
  const values = rows.filter(
    (x) =>
      x.status === "current" &&
      x.observationDate === r.date &&
      finite(x.change) &&
      Math.abs(x.change) >= thresholds[x.id] &&
      x.availableAt &&
      Date.parse(x.availableAt) <= Date.parse(r.builtAt),
  );
  const vix = r.market.metrics.find((x) => x.symbol === "VIX");
  const evidence = values.map(
    (x) =>
      `${x.label} ${x.change! > 0 ? "+" : ""}${n(x.change!)} ${x.changeUnit}`,
  );
  if (finite(vix?.change) && Math.abs(vix.change) >= TOMORROW_RULES.vixPct)
    evidence.push(`VIX ${vix.change > 0 ? "+" : ""}${n(vix.change)}%`);
  return evidence.length
    ? [
        {
          id: "macro:exception",
          domain: "macro",
          group: "market",
          source: "market",
          symbols: [
            ...values.map((x) => x.id),
            ...(finite(vix?.change) &&
            Math.abs(vix.change) >= TOMORROW_RULES.vixPct
              ? ["VIX"]
              : []),
          ],
          title: "宏观与波动指标出现显著变化",
          evidence: evidence.join("；"),
          focus: "观察这些指标的变化是否延续；不同市场的收盘时点分别看待。",
          priority: 86,
        },
      ]
    : [];
}

function candidates(
  r: DailyReview,
  previous: DailyReview | null,
): { events: WatchEvent[]; notes: string[] } {
  const events: WatchEvent[] = [],
    notes: string[] = [];
  const p = previous?.date === r.previousDate ? previous : null;
  const a = r.market.engine,
    b = p?.market.engine;
  if (
    a &&
    b &&
    a.version === b.version &&
    a.state !== "Unknown" &&
    b.state !== "Unknown" &&
    a.state !== b.state
  ) {
    events.push({
      id: "market:state",
      domain: "market",
      group: "market",
      symbols: [],
      source: "market",
      priority: a.state === "Risk-Off" ? 95 : 88,
      title: `${b.label} → ${a.label}`,
      evidence:
        finite(a.temperature.value) && finite(b.temperature.value)
          ? `市场上涨比例 ${n(b.temperature.value)}% → ${n(a.temperature.value)}%`
          : a.evidence[0],
      focus: `观察上涨参与度是否恢复或进一步减弱${finite(a.temperature.value) ? `；当前上涨比例 ${n(a.temperature.value)}%` : ""}。`,
    });
  }
  for (const o of r.options) {
    if (
      o.comparison !== "verified" ||
      !o.today ||
      !o.previous ||
      o.today.as_of?.slice(0, 10) !== r.date ||
      o.previous.as_of?.slice(0, 10) !== r.previousDate ||
      o.today.dte !== o.previous.dte
    )
      continue;
    const today = o.structure ?? optionsStructure(o.today, o.meta);
    const before = optionsStructure(o.previous, o.previousMeta);
    const shifts = (o.shifts ?? []).filter(
      (s) =>
        s.field !== "net_gex" &&
        s.from > 0 &&
        Math.abs(ratio(s.to, s.from)) >= TOMORROW_RULES.wallMovePct,
    );
    const change = ["flip", "wall", "gamma"].some((k) => {
      const key = k as "flip" | "wall" | "gamma";
      return (
        today[key] !== "unknown" &&
        before[key] !== "unknown" &&
        today[key] !== before[key]
      );
    });
    if (!change && !shifts.length) continue;
    events.push({
      id: `options:${o.symbol}`,
      domain: "options",
      group: "market",
      symbols: [o.symbol],
      source: "options",
      priority: 82,
      title: `${o.symbol} 期权结构发生变化`,
      evidence:
        `${FLIP_LABEL[before.flip]} → ${FLIP_LABEL[today.flip]}；${WALL_LABEL[today.wall]}；${GAMMA_LABEL[today.gamma]}` +
        (shifts.length
          ? `；${shifts.map((s) => `${s.field === "gamma_flip" ? "Flip" : s.field === "put_wall" ? "Put Wall" : "Call Wall"} ${n(s.from)} → ${n(s.to)}`).join("；")}`
          : ""),
      focus: `${o.symbol}：观察价格相对 ${finite(o.today.gamma_flip) ? `Flip ${n(o.today.gamma_flip)}` : "Flip"} 与期权墙的位置是否再次改变。`,
    });
  }
  if (r.options.some((o) => o.today && o.comparison !== "verified"))
    notes.push("部分期权快照缺少同版本前值，未将差异作为结构迁移。");
  if (p)
    for (const s of r.sectors) {
      const before = p.sectors.find(
        (x) => x.symbol === s.symbol && x.group === s.group,
      );
      const peers = r.sectors
        .filter((x) => x.group === s.group)
        .map((x) => x.symbol)
        .sort()
        .join();
      const priorPeers = p.sectors
        .filter((x) => x.group === s.group)
        .map((x) => x.symbol)
        .sort()
        .join();
      const benchmark = r.market.metrics.find(
        (x) => x.symbol === "SPY",
      )?.change;
      if (
        peers !== priorPeers ||
        !finite(s.rps) ||
        !finite(before?.rps) ||
        !finite(s.change) ||
        !finite(benchmark)
      )
        continue;
      const delta = s.rps - before.rps,
        relative = s.change - benchmark;
      if (
        Math.abs(delta) < TOMORROW_RULES.sectorRankMove ||
        Math.abs(relative) < TOMORROW_RULES.sectorRelativeDay ||
        delta * relative <= 0
      )
        continue;
      events.push({
        id: `sectors:${s.symbol}`,
        domain: "sectors",
        group: "market",
        symbols: [s.symbol],
        source: "sectors",
        priority: 70 + Math.min(8, Math.abs(delta) / 10),
        title: `${s.name}相对强度${delta > 0 ? "改善" : "减弱"}`,
        evidence: `组内 RPS ${n(before.rps)} → ${n(s.rps)}；今日相对 SPY ${relative > 0 ? "+" : ""}${n(relative)} 个百分点`,
        focus: `观察${s.name}相对 SPY 的${delta > 0 ? "改善" : "弱势"}是否延续；今日相对涨跌 ${relative > 0 ? "+" : ""}${n(relative)} 个百分点。`,
      });
    }
  for (const tf of ["2h", "4h"] as const) {
    const now = sameAccount(r, tf),
      prior = p && sameAccount(p, tf);
    if (!now || !prior) continue;
    const added = now.positions
      .filter((x) => !prior.positions.some((y) => y.symbol === x.symbol))
      .map((x) => x.symbol);
    const removed = prior.positions
      .filter((x) => !now.positions.some((y) => y.symbol === x.symbol))
      .map((x) => x.symbol);
    // An absent/stale account is not a closed account. Daily snapshots describe net changes only.
    if (added.length || removed.length)
      events.push({
        id: `accounts:${tf}`,
        domain: "accounts",
        group: "portfolio",
        symbols: [...added, ...removed],
        tf,
        source: "accounts",
        priority: 90,
        title: `${tf.toUpperCase()} 模型账户持仓变化`,
        evidence: [
          added.length ? `新增 ${added.join(" / ")}` : "",
          removed.length ? `移出 ${removed.join(" / ")}` : "",
        ]
          .filter(Boolean)
          .join("；"),
        focus: `跟踪${added.length ? `新增 ${added.join(" / ")}` : ""}${added.length && removed.length ? "，以及" : ""}${removed.length ? `移出 ${removed.join(" / ")}` : ""}后的表现；其他周期持仓独立看待。`,
      });
  }
  const priorFollowup = p?.followup;
  for (const row of r.followup?.rows ?? []) {
    const before =
      priorFollowup &&
      priorFollowup.date === r.previousDate &&
      priorFollowup.version === r.followup?.version
        ? priorFollowup.rows.find((x) => x.id === row.id)
        : undefined;
    const weakened =
      before && row.strength === "weakening" && before.strength !== "weakening";
    const recovering =
      before &&
      row.strength === "recovering" &&
      before.strength !== "recovering";
    const sectorLost =
      before?.sector &&
      row.sector &&
      before.sector.name === row.sector.name &&
      before.sector.percentile >= 0.8 &&
      row.sector.percentile < 0.8 &&
      row.sector.relative20 <= 0;
    const exited =
      before &&
      row.signal === "exit-recorded" &&
      before.signal !== "exit-recorded";
    if (!weakened && !recovering && !exited && !sectorLost) continue;
    events.push({
      id: `signals:followup:${row.id}`,
      domain: "signals",
      group: "portfolio",
      symbols: [row.symbol],
      tf: row.tf,
      source: "journal",
      priority:
        row.position === "held" && (weakened || sectorLost || exited) ? 96 : 73,
      title: `${row.symbol} ${row.tf.toUpperCase()} ${exited ? "收到退出记录" : sectorLost ? "所属板块转弱" : STRENGTH_LABELS[row.strength]}`,
      evidence: `${before?.rps == null ? "—" : n(before.rps)} → ${row.rps == null ? "—" : n(row.rps)} RPS；${row.position === "held" ? "同周期模型账户持有" : row.position === "not-held" ? "同周期模型账户未持有" : "账户数据待更新"}`,
      focus: exited
        ? "核对信号退出与模型账户持仓，二者分别记录。"
        : "观察相对强度与所属板块是否继续变化；初始买点评分保持不变。",
    });
  }
  // Group new signals by ticker while keeping timeframe and immutable score explicit.
  const newSignals = r.signals.filter(
    (s) =>
      s.date === r.date &&
      s.source === "live" &&
      s.quality.version === "quality-v5" &&
      s.quality.complete &&
      s.quality.points >= TOMORROW_RULES.newSignalScore &&
      Date.parse(s.capturedAt) <= Date.parse(r.builtAt) &&
      s.signalTime <= Date.parse(r.builtAt) &&
      r.followup?.rows.find((x) => x.signalId === s.id)?.signal !==
        "exit-recorded",
  );
  for (const symbol of [...new Set(newSignals.map((s) => s.symbol))]) {
    const list = newSignals.filter((s) => s.symbol === symbol);
    events.push({
      id: `signals:new:${symbol}`,
      domain: "signals",
      group: "portfolio",
      symbols: [symbol],
      source: "signals",
      priority: 65,
      title: `${symbol} 新触发买点`,
      evidence: list
        .map(
          (s) =>
            `${s.tf.toUpperCase()} ${n(s.quality.points)} 分（${s.quality.version}）`,
        )
        .join("；"),
      focus: "观察后续相对强度与退出记录；新信号不代表模型账户已建仓。",
    });
  }
  events.push(...macroWatchEvents(r));
  if (r.market.macro?.rows.some((x) => x.status !== "current"))
    notes.push("过期或缺失的宏观数据不参与异动筛选。");
  if (!p) notes.push("缺少相邻交易日复盘，无法确认的状态变化未列入。");
  return { events, notes };
}

export function selectWatchEvents(events: WatchEvent[]) {
  const sorted = [...events].sort(
    (a, b) => b.priority - a.priority || a.id.localeCompare(b.id),
  );
  const chosen: WatchEvent[] = [];
  for (const e of sorted) {
    if (chosen.some((x) => x.id === e.id)) continue;
    if (
      e.id.startsWith("signals:followup:") &&
      chosen.some(
        (x) =>
          x.id.startsWith("signals:followup:") &&
          x.tf === e.tf &&
          x.symbols[0] === e.symbols[0],
      )
    )
      continue;
    if (
      e.domain === "options" &&
      ["SPX", "SPY"].includes(e.symbols[0]) &&
      chosen.some(
        (x) => x.domain === "options" && ["SPX", "SPY"].includes(x.symbols[0]),
      )
    )
      continue;
    if (
      e.id.startsWith("signals:new:") &&
      chosen.some(
        (x) =>
          x.group === "portfolio" &&
          x.symbols.some((s) => e.symbols.includes(s)),
      )
    )
      continue;
    // Keep the review balanced when one category generates many similar observations.
    if (chosen.filter((x) => x.domain === e.domain).length >= 2) continue;
    chosen.push(e);
    if (chosen.length === TOMORROW_RULES.maxItems) break;
  }
  return chosen;
}

function observe(
  previous: DailyReview | null,
  r: DailyReview,
): TomorrowObservation[] {
  const map = previous?.tomorrow;
  // Historical reconstruction is never presented as a pre-published watchlist.
  if (!map || map.basis !== "published" || map.targetDate !== r.date) return [];
  const cutoff = quoteTimestamp(`${r.date}T09:30:00`) ?? NaN;
  const published = [
    ...map.history.map((h) => ({ at: h.at, events: h.events })),
    { at: map.updatedAt, events: map.events },
  ]
    .filter((h) => Date.parse(h.at) < cutoff)
    .sort((a, b) => a.at.localeCompare(b.at))
    .at(-1);
  if (!published) return [];
  return published.events.map((e) => {
    const texts: string[] = [];
    if (e.domain === "market" && r.market.engine?.state !== "Unknown")
      texts.push(r.market.engine?.label ?? "");
    if (e.domain === "options")
      for (const s of e.symbols) {
        const row = r.options.find(
          (o) => o.symbol === s && o.today?.as_of?.slice(0, 10) === r.date,
        );
        if (row?.structure)
          texts.push(
            `${s}：${FLIP_LABEL[row.structure.flip]} / ${GAMMA_LABEL[row.structure.gamma]} / ${WALL_LABEL[row.structure.wall]}`,
          );
      }
    if (e.domain === "sectors")
      for (const s of e.symbols) {
        const row = r.sectors.find((x) => x.symbol === s);
        if (finite(row?.rps)) texts.push(`${row.name} RPS ${n(row.rps)}`);
      }
    if (e.domain === "accounts" && e.tf) {
      const a = sameAccount(r, e.tf);
      if (a)
        for (const s of e.symbols)
          texts.push(
            `${s}：${a.positions.some((p) => p.symbol === s) ? "持有" : "未持有"}`,
          );
    }
    if (e.domain === "signals")
      for (const row of r.followup?.rows ?? []) {
        if (e.symbols.includes(row.symbol) && (!e.tf || row.tf === e.tf))
          texts.push(
            `${row.symbol} ${row.tf.toUpperCase()}：${SIGNAL_LABELS[row.signal]}，RPS ${row.rps == null ? "—" : n(row.rps)}`,
          );
      }
    if (e.domain === "macro")
      for (const s of e.symbols) {
        const row = r.market.macro?.rows.find(
          (x) =>
            x.id === s &&
            x.status === "current" &&
            x.observationDate === r.date,
        );
        if (finite(row?.change))
          texts.push(`${row.label} ${n(row.change)} ${row.changeUnit}`);
        if (s === "VIX") {
          const v = r.market.metrics.find((x) => x.symbol === s);
          if (finite(v?.change)) texts.push(`VIX ${n(v.change)}%`);
        }
      }
    return {
      eventId: e.id,
      title: e.title,
      text: texts.filter(Boolean).join("；") || "缺少对应交易日观测",
      status: texts.filter(Boolean).length ? "observed" : "missing",
    };
  });
}

function revise(
  map: TomorrowMap,
  prior: TomorrowMap | undefined,
  reason: string,
): TomorrowMap {
  if (!prior || prior.version !== map.version || prior.date !== map.date)
    return map;
  const content = (m: TomorrowMap) =>
    JSON.stringify([
      m.events,
      m.candidates,
      m.notes,
      m.observations,
      m.targetDate,
      m.candidateCount,
    ]);
  if (content(map) === content(prior)) return prior;
  return {
    ...map,
    basis: prior.basis,
    publishedAt: prior.publishedAt,
    revision: prior.revision + 1,
    history: [
      ...prior.history,
      { at: prior.updatedAt, reason, events: prior.events },
    ],
  };
}

export function buildTomorrowMap(
  r: DailyReview,
  previous: DailyReview | null,
  targetDate: string | null,
  basis: TomorrowMap["basis"],
  prior?: TomorrowMap,
): TomorrowMap {
  const result = candidates(r, previous);
  return revise(
    {
      version: TOMORROW_VERSION,
      date: r.date,
      targetDate,
      basis,
      publishedAt: r.builtAt,
      updatedAt: r.builtAt,
      revision: 1,
      events: selectWatchEvents(result.events),
      candidates: result.events,
      candidateCount: result.events.length,
      notes: result.notes,
      observations: observe(previous, r),
      history: [],
    },
    prior,
    "复盘数据更新",
  );
}

/** Rebuild macro selection from saved candidates, never re-run signals/accounts during a supplement. */
export function supplementTomorrowMacro(
  r: DailyReview,
  before: TomorrowMap,
): TomorrowMap {
  const base = before.candidates ?? before.events;
  const events = [
    ...base.filter((e) => e.domain !== "macro"),
    ...macroWatchEvents(r),
  ];
  return revise(
    {
      ...before,
      updatedAt: r.builtAt,
      events: selectWatchEvents(events),
      candidates: events,
      candidateCount: events.length,
      notes: [
        ...before.notes.filter((n) => !n.startsWith("过期或缺失的宏观")),
        ...(r.market.macro?.rows.some((x) => x.status !== "current")
          ? ["过期或缺失的宏观数据不参与异动筛选。"]
          : []),
      ],
    },
    before,
    "宏观数据补采",
  );
}
