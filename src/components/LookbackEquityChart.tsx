"use client";

import { Text } from "@mantine/core";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { bookPnlLabel } from "@/lib/discord/bookCopy";
import type { LookbackPoint } from "@/lib/fund/lookbackLogic";

const POS = "#089981";
const NEG = "#f23645";
const ROTATE = "#d97706";

const pct = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`;

/** 旧缓存只留了 sparkline，用它补一条能看的净值线。 */
export function curveFromSparkline(
  values: readonly number[],
  since: string,
  asOf: string,
): LookbackPoint[] {
  if (values.length < 2) return [];
  const start = Date.parse(`${since.slice(0, 10)}T00:00:00Z`);
  const end = Date.parse(`${asOf.slice(0, 10)}T00:00:00Z`);
  const span = Number.isFinite(start) && Number.isFinite(end) && end > start ? end - start : 0;
  return values.map((equity, i) => {
    const date = span
      ? new Date(start + (span * i) / (values.length - 1)).toISOString().slice(0, 10)
      : String(i);
    return { date, equity, exposurePct: 0, rows: [], buys: [], sells: [], misses: [] };
  });
}

export function LookbackEquityChart({
  curve,
  hoverDate,
  onHover,
  height = 240,
  hint = "曲线上的点：绿买 · 红卖 · 琥珀当天既买又卖 · 灰点是错过的好买点",
}: {
  curve: readonly LookbackPoint[];
  hoverDate?: string | null;
  onHover?: (date: string | null) => void;
  height?: number;
  hint?: string | null;
}) {
  if (curve.length < 2) return null;
  return (
    <div>
      <div style={{ height }}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart
            data={curve as LookbackPoint[]}
            margin={{ top: 8, right: 8, bottom: 0, left: 0 }}
            onMouseMove={(state) => {
              if (!onHover) return;
              const date = typeof state.activeLabel === "string" ? state.activeLabel : null;
              if (date && date !== hoverDate) onHover(date);
            }}
            onMouseLeave={() => onHover?.(null)}
          >
            <CartesianGrid stroke="#27272a" vertical={false} />
            <XAxis
              dataKey="date"
              tick={{ fill: "#71717a", fontSize: 11 }}
              tickLine={false}
              axisLine={{ stroke: "#27272a" }}
              minTickGap={48}
              tickFormatter={(d: string) => d.slice(0, 7)}
            />
            <YAxis
              domain={equityDomain(curve)}
              tick={{ fill: "#71717a", fontSize: 11 }}
              tickLine={false}
              axisLine={false}
              width={56}
              tickFormatter={(v: number) => `${((v - 1) * 100).toFixed(0)}%`}
            />
            <Tooltip
              content={({ active, payload }) => {
                const p = payload?.[0]?.payload as LookbackPoint | undefined;
                if (!active || !p) return null;
                return (
                  <div className="max-w-xs rounded border border-[var(--border-subtle)] bg-[var(--surface-hover)] px-2.5 py-1.5 text-xs">
                    <div className="font-mono">{p.date}</div>
                    <div style={{ color: p.equity >= 1 ? POS : NEG }}>{bookPnlLabel(p.equity)}</div>
                    <div className="mt-1 text-zinc-400">
                      {p.rows.length === 0
                        ? p.exposurePct
                          ? `敞口 ${p.exposurePct.toFixed(0)}%`
                          : "净值"
                        : `持仓 ${p.rows.length} 只 · 敞口 ${p.exposurePct.toFixed(0)}%`}
                    </div>
                    {p.buys.length || p.sells.length ? (
                      <div className="mt-1 font-mono text-zinc-500">
                        {p.buys.length ? `买 ${p.buys.join(" ")}` : ""}
                        {p.buys.length && p.sells.length ? " · " : ""}
                        {p.sells.length ? `卖 ${p.sells.join(" ")}` : ""}
                      </div>
                    ) : null}
                    {p.misses?.length ? (
                      <div className="mt-1 font-mono text-zinc-500">
                        错过 {p.misses.map((m) => `${m.symbol} ${pct(m.laterPct)}`).join(" · ")}
                      </div>
                    ) : null}
                    {p.rows.map((row) => (
                      <div key={row.symbol} className="mt-0.5 flex justify-between gap-4 font-mono">
                        <span>{row.symbol}</span>
                        <span style={{ color: row.floatPnlPct >= 0 ? POS : NEG }}>
                          {row.floatPnlPct >= 0 ? "+" : ""}
                          {row.floatPnlPct.toFixed(1)}%
                        </span>
                      </div>
                    ))}
                  </div>
                );
              }}
              cursor={{ stroke: "#52525b" }}
              isAnimationActive={false}
            />
            <Line
              type="monotone"
              dataKey="equity"
              stroke={POS}
              strokeWidth={1.75}
              isAnimationActive={false}
              dot={tradeDot}
              activeDot={{ r: 4 }}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
      {hint ? (
        <Text size="xs" c="dimmed" mt="xs">
          {hint}
        </Text>
      ) : null}
    </div>
  );
}

function equityDomain(curve: readonly LookbackPoint[]): [number, number] {
  const xs = curve.map((p) => p.equity);
  const lo = Math.min(1, ...xs);
  const hi = Math.max(1, ...xs);
  const pad = Math.max((hi - lo) * 0.15, 0.02);
  return [lo - pad, hi + pad];
}

function tradeDot(props: { cx?: number; cy?: number; payload?: LookbackPoint }) {
  const p = props.payload;
  if (p == null || props.cx == null || props.cy == null) return null;
  if (p.buys.length || p.sells.length) {
    const fill = p.buys.length > 0 && p.sells.length > 0 ? ROTATE : p.buys.length > 0 ? POS : NEG;
    return <circle cx={props.cx} cy={props.cy} r={3.5} fill={fill} />;
  }
  if (!p.misses?.length) return null;
  return <circle cx={props.cx} cy={props.cy} r={3} fill="#a1a1aa" />;
}
