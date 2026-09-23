import {
  MACRO_SERIES,
  mergeObservations,
  type MacroArchive,
} from "@/lib/review/macro";
import { readSnapshot, writeSnapshot } from "@/lib/vps/snapshot";
import { fetchYahooDailyBars } from "./yahoo";

export function parseFredCsv(
  text: string,
  id: string,
): { observationDate: string; value: number }[] {
  const [header, ...lines] = text.trim().split(/\r?\n/);
  const columns = header?.replace(/^\uFEFF/, "").split(",");
  const index = columns?.indexOf(id) ?? -1;
  if (index < 1 || !["observation_date", "DATE"].includes(columns[0]))
    throw new Error(`Invalid FRED CSV: ${id}`);
  return lines.flatMap((line) => {
    const fields = line.split(","),
      value = fields[index]?.trim();
    return /^\d{4}-\d{2}-\d{2}$/.test(fields[0]) &&
      value &&
      value !== "." &&
      Number.isFinite(Number(value))
      ? [{ observationDate: fields[0], value: Number(value) }]
      : [];
  });
}
/** 不使用推算发布日期；availableAt 是本系统第一次抓到这个值的时间。 */
export async function refreshReviewMacro(until: string): Promise<MacroArchive> {
  const old = await readSnapshot<MacroArchive>("macro-observations");
  const fetchedAt = new Date().toISOString();
  const series = { ...old?.series },
    errors: string[] = [];
  const results = await Promise.allSettled(
    MACRO_SERIES.map(async (def) => {
      let values: { observationDate: string; value: number }[];
      if (def.provider === "fred") {
        const start = `${Number(until.slice(0, 4)) - 2}${until.slice(4)}`;
        const response = await fetch(
          `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${def.symbol}&cosd=${start}&coed=${until}`,
          { signal: AbortSignal.timeout(20000), cache: "no-store" },
        );
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        values = parseFredCsv(await response.text(), def.symbol);
      } else {
        values = (
          await fetchYahooDailyBars(def.symbol, { years: 2, timeoutMs: 20000 })
        ).map((r) => ({ observationDate: r.date, value: r.close }));
      }
      values = values.filter(
        (r) =>
          r.observationDate <= until &&
          (def.id !== "BTC" || r.observationDate < fetchedAt.slice(0, 10)),
      );
      if (!values.length) throw new Error("No completed observations");
      series[def.id] = mergeObservations(
        series[def.id] ?? [],
        values,
        new Date().toISOString(),
      );
    }),
  );
  results.forEach((result, i) => {
    if (result.status === "rejected")
      errors.push(
        `${MACRO_SERIES[i].id}: ${result.reason instanceof Error ? result.reason.message : "fetch failed"}`,
      );
  });
  const archive: MacroArchive = {
    version: 1,
    updatedAt: new Date().toISOString(),
    series,
    errors,
  };
  writeSnapshot("macro-observations", archive);
  return archive;
}
