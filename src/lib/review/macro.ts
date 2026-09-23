export const MACRO_SERIES = [
  {
    id: "DGS10",
    label: "10Y 名义利率",
    provider: "fred",
    symbol: "DGS10",
    unit: "%",
    threshold: 3,
    note: "美联储 H.15 / FRED；日频，可能延后一交易日发布",
  },
  {
    id: "DGS2",
    label: "2Y 名义利率",
    provider: "fred",
    symbol: "DGS2",
    unit: "%",
    threshold: 3,
    note: "美联储 H.15 / FRED；政策利率预期背景",
  },
  {
    id: "DFII10",
    label: "10Y 实际利率",
    provider: "fred",
    symbol: "DFII10",
    unit: "%",
    threshold: 3,
    note: "通胀保值国债收益率；与名义利率分开",
  },
  {
    id: "DXY",
    label: "美元指数",
    provider: "yahoo",
    symbol: "DX-Y.NYB",
    unit: "index",
    threshold: 0.3,
    note: "Yahoo / ICE 美元指数，供应商日线",
  },
  {
    id: "WTI",
    label: "WTI 原油期货",
    provider: "yahoo",
    symbol: "CL=F",
    unit: "USD",
    threshold: 1,
    note: "Yahoo 近月连续期货；换月可能影响日变化，不是现货",
  },
  {
    id: "GOLD",
    label: "黄金期货",
    provider: "yahoo",
    symbol: "GC=F",
    unit: "USD",
    threshold: 0.5,
    note: "Yahoo 近月连续期货；换月可能影响日变化，不是现货",
  },
  {
    id: "BTC",
    label: "BTC / USD",
    provider: "yahoo",
    symbol: "BTC-USD",
    unit: "USD",
    threshold: 2,
    note: "UTC 自然日日线；并非美股 16:00 同时收盘",
  },
] as const;
export type MacroId = (typeof MACRO_SERIES)[number]["id"];
export type MacroObservation = {
  observationDate: string;
  value: number;
  availableAt: string;
  fetchedAt: string;
};
export type MacroArchive = {
  version: 1;
  updatedAt: string;
  series: Partial<Record<MacroId, MacroObservation[]>>;
  errors: string[];
};
export type MacroRow = {
  id: MacroId;
  label: string;
  source: string;
  note: string;
  unit: string;
  value: number | null;
  change: number | null;
  changeUnit: "bp" | "%";
  observationDate: string | null;
  previousDate: string | null;
  availableAt: string | null;
  fetchedAt: string | null;
  status: "current" | "delayed" | "stale" | "missing";
  direction: "Rising" | "Stable" | "Falling" | "Unknown";
};
export type MacroEnvironment = {
  regime: "Supportive" | "Neutral" | "Restrictive" | "Mixed" | "Unknown";
  effectiveDate: string | null;
  rows: MacroRow[];
  evidence: string[];
  basis: "first-observed" | "reconstructed";
};
/** 保留修订的首次可见时间；同值刷新只更新 fetchedAt，不伪造历史发布时刻。 */
export function mergeObservations(
  old: MacroObservation[],
  incoming: { observationDate: string; value: number }[],
  fetchedAt: string,
): MacroObservation[] {
  const out = [...old];
  for (const row of incoming) {
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(row.observationDate) ||
      !Number.isFinite(row.value)
    )
      continue;
    let i = -1;
    for (let j = out.length - 1; j >= 0; j--)
      if (out[j].observationDate === row.observationDate) {
        i = j;
        break;
      }
    if (i >= 0 && out[i].value === row.value) out[i] = { ...out[i], fetchedAt };
    else out.push({ ...row, availableAt: fetchedAt, fetchedAt });
  }
  return out.sort(
    (a, b) =>
      a.observationDate.localeCompare(b.observationDate) ||
      a.availableAt.localeCompare(b.availableAt),
  );
}
export function macroEnvironment(
  archive: MacroArchive | null,
  date: string,
  sessions: string[],
  asOf: string,
  reconstructed = false,
): MacroEnvironment {
  const visible = (id: MacroId) => {
    const map = new Map<string, MacroObservation>();
    for (const r of archive?.series[id] ?? []) {
      if (
        r.observationDate > date ||
        !Number.isFinite(r.value) ||
        !Number.isFinite(Date.parse(r.availableAt))
      )
        continue;
      if (!reconstructed && Date.parse(r.availableAt) > Date.parse(asOf))
        continue;
      const old = map.get(r.observationDate);
      if (!old || r.availableAt > old.availableAt)
        map.set(r.observationDate, r);
    }
    return [...map.values()].sort((a, b) =>
      a.observationDate.localeCompare(b.observationDate),
    );
  };
  const rows: MacroRow[] = MACRO_SERIES.map((def) => {
    const observations = visible(def.id),
      last = observations.at(-1),
      prev = observations.at(-2);
    const lag = last
      ? sessions.filter((d) => d > last.observationDate && d <= date).length
      : Infinity;
    const prior =
      last &&
      (def.id === "BTC"
        ? new Date(Date.parse(`${last.observationDate}T00:00:00Z`) - 86400000)
            .toISOString()
            .slice(0, 10)
        : sessions[sessions.indexOf(last.observationDate) - 1]);
    const comparable = !!last && !!prev && prev.observationDate === prior;
    const status = !last
      ? "missing"
      : last.observationDate === date
        ? "current"
        : def.provider === "fred" && lag <= 1
          ? "delayed"
          : "stale";
    const change = comparable
      ? def.provider === "fred"
        ? (last.value - prev.value) * 100
        : prev.value > 0
          ? (last.value / prev.value - 1) * 100
          : null
      : null;
    const usable = status === "current" || status === "delayed";
    return {
      id: def.id,
      label: def.label,
      source:
        def.provider === "fred"
          ? `FRED / ${def.symbol}`
          : `Yahoo / ${def.symbol}`,
      note: def.note,
      unit: def.unit,
      value: last?.value ?? null,
      change,
      changeUnit: def.provider === "fred" ? "bp" : "%",
      observationDate: last?.observationDate ?? null,
      previousDate: prev?.observationDate ?? null,
      availableAt: last?.availableAt ?? null,
      fetchedAt: last?.fetchedAt ?? null,
      status,
      direction:
        !usable || change == null
          ? "Unknown"
          : change > def.threshold + 1e-8
            ? "Rising"
            : change < -def.threshold - 1e-8
              ? "Falling"
              : "Stable",
    };
  });
  const core = rows.filter((r) => ["DGS10", "DGS2", "DXY"].includes(r.id));
  let regime: MacroEnvironment["regime"] = "Unknown";
  let effectiveDate: string | null = null;
  const evidence: string[] = [];
  if (core.every((r) => r.status === "current" || r.status === "delayed")) {
    effectiveDate = core.map((r) => r.observationDate!).sort()[0];
    const previous = sessions[sessions.indexOf(effectiveDate) - 1];
    const changes = core.map((r) => {
      const xs = visible(r.id),
        a = xs.find((x) => x.observationDate === effectiveDate),
        b = xs.find((x) => x.observationDate === previous);
      if (!a || !b) return null;
      const value =
        r.changeUnit === "bp"
          ? (a.value - b.value) * 100
          : b.value > 0
            ? (a.value / b.value - 1) * 100
            : NaN;
      if (!Number.isFinite(value)) return null;
      const threshold = MACRO_SERIES.find((d) => d.id === r.id)!.threshold;
      evidence.push(
        `${r.label} ${value > 0 ? "+" : ""}${value.toFixed(2)} ${r.changeUnit}（${effectiveDate}）。`,
      );
      return value > threshold + 1e-8 ? 1 : value < -threshold - 1e-8 ? -1 : 0;
    });
    if (changes.every((x) => x != null)) {
      const up = changes.filter((x) => x === 1).length,
        down = changes.filter((x) => x === -1).length;
      regime =
        up >= 2 && down === 0
          ? "Restrictive"
          : down >= 2 && up === 0
            ? "Supportive"
            : up === 0 && down === 0
              ? "Neutral"
              : "Mixed";
    }
  }
  if (regime === "Unknown")
    evidence.push("利率 / 美元缺少新鲜且同日期的完整比较，宏观环境暂不判定。");
  evidence.push(
    "标签仅描述名义利率与美元的共同变化；原油、黄金、BTC 和实际利率单列观察，不覆盖内部市场状态。",
  );
  return {
    regime,
    effectiveDate,
    rows,
    evidence,
    basis: reconstructed ? "reconstructed" : "first-observed",
  };
}
