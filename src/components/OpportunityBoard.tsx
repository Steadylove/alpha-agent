"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";

import { flattenStocksBySector, matchStock, pageSlice } from "@/lib/opportunity/groupStocks";
import type { OpportunityData, OpportunitySectorRow, OpportunityStock } from "@/lib/opportunity/types";
import type { SectorClockStatus } from "@/lib/scoring/sectorClock";

const STATUS: Record<SectorClockStatus, string> = {
  leader: "领涨",
  bottoming: "回流",
  neutral: "中性",
  outflow: "流出",
};

function signed(n: number, digits = 1): string {
  const v = n.toFixed(digits);
  return n > 0 ? `+${v}` : v;
}

function namesOf(ids: readonly string[], sectors: OpportunitySectorRow[]): string {
  return ids.map((id) => sectors.find((s) => s.id === id)?.name ?? id).join("、");
}

function Delta({ value }: { value: number | null }) {
  if (value == null) return <span className="text-zinc-600">—</span>;
  const tone = value > 0 ? "text-(--pos)" : value < 0 ? "text-(--neg)" : "text-zinc-500";
  return <span className={tone}>{signed(value, 0)}</span>;
}

function Marks({
  stock,
  showPool,
}: {
  stock: OpportunityStock;
  showPool: boolean;
}) {
  const tags = [
    showPool && stock.inLivePool ? "在池" : null,
    stock.elite ? "精英" : null,
    stock.newHigh ? "新高" : null,
  ].filter(Boolean);
  if (tags.length === 0) return <span className="text-zinc-600">—</span>;
  return (
    <span className="flex flex-wrap gap-1">
      {tags.map((tag) => (
        <span
          key={tag}
          className="rounded bg-zinc-800 px-1.5 py-0.5 text-[11px] leading-none text-zinc-400"
        >
          {tag}
        </span>
      ))}
    </span>
  );
}

function SectorTable({ rows }: { rows: OpportunitySectorRow[] }) {
  return (
    <div className="overflow-x-auto">
      <table>
        <thead>
          <tr>
            <th>行业</th>
            <th>状态</th>
            <th className="text-right">名次</th>
            <th className="text-right">行业 RPS</th>
            <th className="text-right">Δ</th>
            <th className="text-right">63 日</th>
            <th className="text-right">21 日超额</th>
            <th className="text-right">广度</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              <td>
                <span className="font-medium text-zinc-100">{row.name}</span>
                <span className="ml-2 font-mono text-xs text-zinc-500">{row.symbol}</span>
              </td>
              <td>{STATUS[row.status]}</td>
              <td className="text-right font-mono">{row.rank}</td>
              <td className="text-right font-mono">{row.rps.toFixed(0)}</td>
              <td className="text-right font-mono">
                <Delta value={row.rpsDelta} />
              </td>
              <td className="text-right font-mono">{row.sls.toFixed(3)}</td>
              <td className="text-right font-mono">{signed(row.mom21 * 100, 2)}%</td>
              <td className="text-right font-mono text-zinc-500">
                {row.breadth
                  ? `${row.breadth.strong}/${row.breadth.sample} · 抬头 ${row.breadth.rising}`
                  : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const PAGE_SIZE = 20;

function sectorTitle(stock: OpportunityStock, sectors: OpportunitySectorRow[]): string {
  return sectors.find((s) => s.id === stock.sectorId)?.name ?? "未分类";
}

function StockTable({
  rows,
  sectors,
  showPoolMark,
}: {
  rows: OpportunityStock[];
  sectors: OpportunitySectorRow[];
  showPoolMark: boolean;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="table-fixed">
        <colgroup>
          <col className="w-20" />
          <col className="w-24" />
          <col />
          <col className="w-24" />
          <col className="w-16" />
          <col className="w-40" />
        </colgroup>
        <thead>
          <tr>
            <th>代码</th>
            <th>行业</th>
            <th>细分</th>
            <th className="text-right">RPS250</th>
            <th className="text-right">Δ</th>
            <th>标记</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((s) => (
            <tr key={s.symbol}>
              <td>
                <Link
                  href={`/desk?q=${encodeURIComponent(s.symbol)}`}
                  className="font-mono text-zinc-100 underline decoration-zinc-700 underline-offset-2 hover:decoration-(--accent)"
                >
                  {s.symbol}
                </Link>
              </td>
              <td className="text-zinc-400">{sectorTitle(s, sectors)}</td>
              <td className="truncate text-zinc-400">{s.industryLabel || "—"}</td>
              <td className="text-right font-mono">
                {s.rps250 == null ? "—" : s.rps250.toFixed(0)}
              </td>
              <td className="text-right font-mono">
                <Delta value={s.rpsDelta} />
              </td>
              <td className="whitespace-nowrap">
                <Marks stock={s} showPool={showPoolMark} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PagedStockList({
  stocks,
  sectors,
  showPoolMark,
  empty,
}: {
  stocks: OpportunityStock[];
  sectors: OpportunitySectorRow[];
  showPoolMark: boolean;
  empty?: string;
}) {
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const matched = useMemo(() => {
    return flattenStocksBySector(stocks, sectors).filter((s) =>
      matchStock(s, query, sectorTitle(s, sectors)),
    );
  }, [stocks, sectors, query]);

  useEffect(() => {
    setPage(1);
  }, [query, stocks]);

  const slice = pageSlice(matched, page, PAGE_SIZE);

  return (
    <div>
      <label className="mb-4 block text-xs text-zinc-500">
        搜索代码 / 名称 / 行业
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="NVDA 或 能源"
          className="mt-1 block h-11 w-full max-w-xs rounded-lg border border-(--border-subtle) bg-(--surface-sunken) px-3 text-sm text-zinc-100"
        />
      </label>
      {slice.rows.length === 0 ? (
        <p className="text-xs text-zinc-600">{empty ?? "没有符合条件的票。"}</p>
      ) : (
        <StockTable rows={slice.rows} sectors={sectors} showPoolMark={showPoolMark} />
      )}
      {matched.length > 0 ? (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-xs text-zinc-500">
          <p>
            第 {slice.page} / {slice.pages} 页 · {matched.length} 只 · 每页 {PAGE_SIZE} 只
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={slice.page <= 1}
              onClick={() => setPage(slice.page - 1)}
              className="inline-flex min-h-11 items-center rounded-lg border border-(--border-subtle) px-3 text-zinc-200 disabled:opacity-40"
            >
              上一页
            </button>
            <button
              type="button"
              disabled={slice.page >= slice.pages}
              onClick={() => setPage(slice.page + 1)}
              className="inline-flex min-h-11 items-center rounded-lg border border-(--border-subtle) px-3 text-zinc-200 disabled:opacity-40"
            >
              下一页
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function UniverseSection({
  stocks,
  sectors,
}: {
  stocks: OpportunityStock[];
  sectors: OpportunitySectorRow[];
}) {
  const [scope, setScope] = useState<"all" | "strong" | "pool">("all");
  const strongCount = stocks.filter((s) => (s.rps250 ?? 0) >= 80).length;
  const poolCount = stocks.filter((s) => s.inLivePool).length;
  const shown = stocks.filter((s) => {
    if (scope === "strong") return (s.rps250 ?? 0) >= 80;
    if (scope === "pool") return s.inLivePool;
    return true;
  });

  return (
    <section className="rounded-xl border border-(--border-subtle) bg-(--surface-raised) p-5">
      <h2 className="mb-2 text-sm font-semibold text-zinc-100">全市场截面</h2>
      <p className="mb-4 text-xs text-zinc-500">
        标普日线截面 {stocks.length} 只，不是现网 55 只。点代码只去信号台，不加池。
      </p>
      <div className="mb-4 flex flex-wrap gap-2">
        {(
          [
            ["all", `全部 ${stocks.length}`],
            ["strong", `强势 ${strongCount}`],
            ["pool", `在池 ${poolCount}`],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => setScope(id)}
            className={`inline-flex min-h-11 items-center rounded-lg border px-3 text-xs ${
              scope === id
                ? "border-(--border-strong) bg-(--surface-hover) text-zinc-100"
                : "border-(--border-subtle) text-zinc-400"
            }`}
          >
            {label}
          </button>
        ))}
      </div>
      <PagedStockList stocks={shown} sectors={sectors} showPoolMark empty="没有符合条件的票" />
    </section>
  );
}

export function OpportunityBoard({ data }: { data: OpportunityData }) {
  if (!data.asOf) {
    return (
      <p className="text-sm text-zinc-500">
        日更尚未写出机会快照。时钟用 SPY 与 11 只行业 ETF，不改现网买卖。
        {data.missingSymbols.length > 0 ? ` 缺 ${data.missingSymbols.join(" ")}。` : ""}
      </p>
    );
  }

  const leaders = namesOf(data.leaders, data.sectors);
  const bottoming = namesOf(data.bottoming, data.sectors);

  return (
    <div className="space-y-8">
      <section className="rounded-xl border border-(--border-subtle) bg-(--surface-raised) p-5">
        <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-sm font-semibold text-zinc-100">行业时钟</h2>
          <p className="font-mono text-xs text-zinc-500">截至 {data.asOf}</p>
        </div>
        <p className="mb-4 text-xs text-zinc-500">
          领涨 {leaders || "—"}。回流 {bottoming || "—"}。改池时看这里。
        </p>
        <SectorTable rows={data.sectors} />
      </section>

      {data.universe.length > 0 ? (
        <UniverseSection stocks={data.universe} sectors={data.sectors} />
      ) : (
        <p className="text-xs text-zinc-600">今日个股截面未生成。行业时钟仍可用。</p>
      )}

      {data.pool.length > 0 ? (
        <section className="rounded-xl border border-(--border-subtle) bg-(--surface-raised) p-5">
          <h2 className="mb-2 text-sm font-semibold text-zinc-100">现网池对照</h2>
          <p className="mb-4 text-xs text-zinc-500">这 {data.pool.length} 只是现网名单，只对照，不改。</p>
          <PagedStockList stocks={data.pool} sectors={data.sectors} showPoolMark={false} />
        </section>
      ) : null}
    </div>
  );
}
