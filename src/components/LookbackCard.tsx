"use client";

import { useEffect, useState } from "react";
import { Alert, Badge, Button, Group, NumberInput, SegmentedControl, Stack, Table, Text, TextInput } from "@mantine/core";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { Card } from "@/components/Card";
import { DayPicker } from "@/components/DayPicker";
import { bookPnlLabel } from "@/lib/discord/bookCopy";
import {
  clampLookbackSlots,
  DEFAULT_LOOKBACK_SLOTS,
  type LookbackPoint,
  type LookbackTf,
  type LookbackView,
} from "@/lib/fund/lookbackLogic";
import { defaultSnapshotName, type LookbackSnapshot } from "@/lib/fund/lookbackSnapshotLogic";

const POS = "#089981";
const NEG = "#f23645";

type Result = LookbackView & { tf: LookbackTf };

export function LookbackCard({
  members,
  onRestore,
}: {
  members: string[] | null;
  onRestore?: (members: string[]) => void;
}) {
  const [tf, setTf] = useState<LookbackTf>("4h");
  const [from, setFrom] = useState("");
  const [slots, setSlots] = useState<number | string>(DEFAULT_LOOKBACK_SLOTS);
  const [cache, setCache] = useState<Partial<Record<string, Result>>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hoverDate, setHoverDate] = useState<string | null>(null);
  const [snapName, setSnapName] = useState("");
  const [snapshots, setSnapshots] = useState<LookbackSnapshot[]>([]);
  const [saving, setSaving] = useState(false);
  const poolSig = members?.join(",") ?? "";
  const slotN = clampLookbackSlots(slots);

  useEffect(() => {
    setCache({});
    setHoverDate(null);
  }, [poolSig]);

  useEffect(() => {
    void fetch("/api/lookback-snapshots")
      .then((r) => r.json())
      .then((j) => {
        if (Array.isArray(j.snapshots)) setSnapshots(j.snapshots);
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    void fetch("/api/signal-book")
      .then((r) => r.json())
      .then((j) => {
        if (typeof j.from === "string") setFrom((cur) => cur || j.from);
      })
      .catch(() => undefined);
  }, []);

  const key = `${tf}|${from}|${slotN ?? ""}`;
  const view = cache[key] ?? null;

  const run = async (nextTf = tf) => {
    if (!from) return;
    const nextSlots = clampLookbackSlots(slots);
    if (nextSlots == null) {
      setError("最多持仓必须是 1–20");
      return;
    }
    if (members && members.length === 0) {
      setError("信号池是空的");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (!members) throw new Error("临时池还没就绪");
      const res = await fetch("/api/lookback", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tf: nextTf, from, members, slots: nextSlots }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "回看失败");
      const next = json as Result;
      setHoverDate(null);
      setCache((prev) => ({ ...prev, [`${next.tf}|${from}|${nextSlots}`]: next }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "回看失败");
    } finally {
      setBusy(false);
    }
  };

  const saveSnap = async () => {
    if (!view || !members?.length || slotN == null) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/lookback-snapshots", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "save",
          name: snapName,
          members,
          tf: view.tf,
          from,
          slots: slotN,
          asOf: view.asOf,
          pnl: view.pnl,
          equity: view.equity,
          cagr: view.stats.cagr,
          dd: view.stats.dd,
          mar: view.stats.mar,
          ytdPct: view.stats.ytdPct,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "保存失败");
      setSnapshots(json.snapshots ?? []);
      setSnapName("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "保存失败");
    } finally {
      setSaving(false);
    }
  };

  const dropSnap = async (id: string) => {
    setError(null);
    try {
      const res = await fetch("/api/lookback-snapshots", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "delete", id }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "删除失败");
      setSnapshots(json.snapshots ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "删除失败");
    }
  };

  const loadSnap = (snap: LookbackSnapshot) => {
    setTf(snap.tf);
    setFrom(snap.from);
    setSlots(snap.slots);
    setCache({});
    setHoverDate(null);
    onRestore?.(snap.members);
  };

  const placeholder = view
    ? defaultSnapshotName({ from, members: members ?? [], tf: view.tf, pnl: view.pnl })
    : "先回看再保存";

  return (
    <Card title="临时回看">
      <Text size="sm" c="dimmed" mb="md">
        只用上方临时回看池（{members ? `${members.length} 只` : "读取中"}
        ）。最多持仓默认 10 只，每笔投 1/N，可改。2 小时用扩池档。从选定日起空仓算到最近一根。改池或只数后请再点回看。不写
        Discord 信号池。
      </Text>
      {error ? (
        <Alert color="red" variant="light" mb="sm">
          {error}
        </Alert>
      ) : null}
      <Group align="flex-end" wrap="wrap" gap="sm" mb="md">
        <DayPicker label="起点" value={from} onChange={setFrom} />
        <SegmentedControl
          size="sm"
          value={tf}
          onChange={(v) => {
            const next = v as LookbackTf;
            setTf(next);
            if (from && members?.length && slotN != null && !cache[`${next}|${from}|${slotN}`]) void run(next);
          }}
          data={[
            { value: "4h", label: "4 小时" },
            { value: "2h", label: "2 小时" },
          ]}
        />
        <NumberInput
          size="sm"
          label="最多持仓"
          value={slots}
          onChange={setSlots}
          min={1}
          max={20}
          allowDecimal={false}
          w={96}
        />
        <Button
          variant="light"
          loading={busy}
          disabled={!from || !members || members.length === 0 || slotN == null}
          onClick={() => void run()}
        >
          回看
        </Button>
      </Group>
      <Group align="flex-end" wrap="wrap" gap="sm" mb="md">
        <TextInput
          size="sm"
          label="快照名"
          placeholder={placeholder}
          value={snapName}
          onChange={(e) => setSnapName(e.currentTarget.value)}
          w={280}
        />
        <Button
          size="sm"
          variant="default"
          loading={saving}
          disabled={!view || !members?.length}
          onClick={() => void saveSnap()}
        >
          保存快照
        </Button>
      </Group>
      {snapshots.length > 0 ? (
        <Table fz="xs" mb="md" verticalSpacing={4}>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>快照</Table.Th>
              <Table.Th ta="right">只数</Table.Th>
              <Table.Th>周期</Table.Th>
              <Table.Th ta="right">累计</Table.Th>
              <Table.Th />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {snapshots.map((snap) => (
              <Table.Tr key={snap.id}>
                <Table.Td>
                  <Text size="xs" fw={600}>
                    {snap.name}
                  </Text>
                  <Text size="xs" c="dimmed" ff="monospace">
                    {snap.from} · 持仓{snap.slots}
                  </Text>
                </Table.Td>
                <Table.Td ta="right" ff="monospace">
                  {snap.members.length}
                </Table.Td>
                <Table.Td>{snap.tf === "4h" ? "4 小时" : "2 小时"}</Table.Td>
                <Table.Td ta="right" ff="monospace" style={{ color: snap.equity >= 1 ? POS : NEG }}>
                  {snap.pnl}
                </Table.Td>
                <Table.Td>
                  <Group gap={6} justify="flex-end">
                    <Button size="compact-xs" variant="light" onClick={() => loadSnap(snap)}>
                      载入
                    </Button>
                    <Button size="compact-xs" variant="subtle" color="red" onClick={() => void dropSnap(snap.id)}>
                      删
                    </Button>
                  </Group>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      ) : (
        <Text size="xs" c="dimmed" mb="md">
          回看出成绩后可把当前名单和收益存成快照，下次载入名单再回看。
        </Text>
      )}
      {view ? (
        <LookbackResult view={view} hoverDate={hoverDate} onHover={setHoverDate} />
      ) : (
        <Text size="xs" c="dimmed">
          选定起点后点回看。第一次要准备全池，大约十几秒。
        </Text>
      )}
    </Card>
  );
}

function LookbackResult({
  view,
  hoverDate,
  onHover,
}: {
  view: LookbackView;
  hoverDate: string | null;
  onHover: (date: string | null) => void;
}) {
  const point =
    (hoverDate ? view.curve.find((p) => p.date === hoverDate) : null) ?? view.curve.at(-1) ?? null;
  const rows = point?.rows ?? view.rows;
  const dayPnl = point ? bookPnlLabel(point.equity) : view.pnl;
  const s = view.stats;
  const pct = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`;
  const tone = (v: number) => (v >= 0 ? POS : NEG);

  return (
    <>
      <Group gap="lg" wrap="wrap" mb="sm">
        <Stat label="累计" value={view.pnl} color={tone(view.equity - 1)} />
        {s.ytdPct != null && Math.abs(s.ytdPct - (view.equity - 1) * 100) >= 0.05 ? (
          <Stat
            label={s.ytdYear != null ? `${s.ytdYear} YTD` : "YTD"}
            value={pct(s.ytdPct)}
            color={tone(s.ytdPct)}
          />
        ) : null}
        <Stat label="CAGR" value={pct(s.cagr)} color={tone(s.cagr)} />
        <Stat label="回撤" value={`${s.dd.toFixed(0)}%`} color={NEG} />
        <Stat label="MAR" value={s.mar.toFixed(2)} />
        <Stat label="均持" value={s.avgHoldings.toFixed(1)} />
        <Stat label="敞口" value={`${s.avgExposure.toFixed(0)}%`} />
        <Stat label="年换手" value={s.tradesPerYear.toFixed(0)} />
        <Stat label="入场" value={String(s.entries)} />
      </Group>
      <Text size="xs" c="dimmed" mb="sm" ff="monospace">
        {view.since} → {(point?.date ?? view.asOf).replace("T", " ").slice(0, 16)} · 当天 {dayPnl} · 持仓{" "}
        {rows.length} 只 · 敞口 {(point?.exposurePct ?? view.exposurePct).toFixed(0)}%
      </Text>
      <div style={{ height: 240 }}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart
            data={view.curve}
            margin={{ top: 8, right: 8, bottom: 0, left: 0 }}
            onMouseMove={(state) => {
              const date = typeof state.activeLabel === "string" ? state.activeLabel : null;
              if (date && date !== hoverDate) onHover(date);
            }}
            onMouseLeave={() => onHover(null)}
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
              domain={equityDomain(view.curve)}
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
                        ? "空仓"
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
      <Text size="xs" c="dimmed" mt="xs">
        曲线上的点：绿买 · 红卖 · 琥珀当天既买又卖 · 灰点是错过的好买点
      </Text>
      {(view.misses ?? []).length > 0 ? (
        <div className="mt-3">
          <Text size="xs" c="dimmed" mb={6}>
            错过的好买点 · 满仓没开、到期末涨得比当时净值多
          </Text>
          <Group gap={6}>
            {view.misses.slice(0, 8).map((m) => (
              <Badge key={`${m.date}-${m.symbol}`} size="sm" color="gray" variant="light">
                {m.symbol} {pct(m.laterPct)} · {m.date.slice(5)}
              </Badge>
            ))}
          </Group>
          {view.misses.length > 8 ? (
            <Text size="xs" c="dimmed" mt={6}>
              还有 {view.misses.length - 8} 只
            </Text>
          ) : null}
        </div>
      ) : null}
      {point && (point.buys.length > 0 || point.sells.length > 0) ? (
        <Group gap={6} mt="sm">
          {point.buys.map((s) => (
            <Badge key={`b-${s}`} size="sm" color="teal" variant="light">
              买 {s}
            </Badge>
          ))}
          {point.sells.map((s) => (
            <Badge key={`s-${s}`} size="sm" color="red" variant="light">
              卖 {s}
            </Badge>
          ))}
        </Group>
      ) : null}
      {rows.length === 0 ? (
        <Text size="xs" c="dimmed" mt="sm">
          空仓
        </Text>
      ) : (
        <Table fz="xs" mt="sm" verticalSpacing={4}>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>代码</Table.Th>
              <Table.Th ta="right">浮盈</Table.Th>
              <Table.Th ta="right">开仓价</Table.Th>
              <Table.Th ta="right">仓位</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {rows.map((row) => (
              <Table.Tr key={row.symbol}>
                <Table.Td ff="monospace" fw={600}>
                  {row.symbol}
                </Table.Td>
                <Table.Td ta="right" ff="monospace" style={{ color: row.floatPnlPct >= 0 ? POS : NEG }}>
                  {row.floatPnlPct >= 0 ? "+" : ""}
                  {row.floatPnlPct.toFixed(1)}%
                </Table.Td>
                <Table.Td ta="right" ff="monospace">
                  {row.entryPrice.toFixed(2)}
                </Table.Td>
                <Table.Td ta="right" ff="monospace">
                  {row.weightPct.toFixed(1)}%
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      )}
    </>
  );
}

const ROTATE = "#d97706";

/** Recharts 默认把 Y 轴锚到 0，净值 0 会被标成 -100%。按曲线收紧。 */
function equityDomain(curve: readonly LookbackPoint[]): [number, number] {
  const xs = curve.map((p) => p.equity);
  const lo = Math.min(1, ...xs);
  const hi = Math.max(1, ...xs);
  const pad = Math.max((hi - lo) * 0.15, 0.02);
  return [lo - pad, hi + pad];
}

function Stat({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <Stack gap={2} w={64}>
      <Text size="xs" c="dimmed">
        {label}
      </Text>
      <Text size="lg" fw={600} ff="monospace" style={color ? { color } : undefined}>
        {value}
      </Text>
    </Stack>
  );
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
