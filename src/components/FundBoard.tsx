"use client";

import { useMemo, useState } from "react";
import { Alert, Badge, Button, Group, Loader, SegmentedControl, Table, Text, UnstyledButton } from "@mantine/core";

import { Card, MetricCard } from "@/components/Card";
import { LabSymbolChart, type ChartTarget } from "@/components/LabSymbolChart";
import { curveFromSparkline, LookbackEquityChart } from "@/components/LookbackEquityChart";
import { daysOpenLabel, daysOpenOf, pnlLabel } from "@/lib/discord/bookCopy";
import { LIVE_BOOKS, liveBookName, liveBookEpoch } from "@/lib/fund/liveBooksLogic";
import type { BookEpochs } from "@/lib/fund/bookEpochLogic";
import { BookEpochCard } from "@/components/BookEpochCard";
import type { ApplyBookSettings } from "@/components/FundWorkbench";
import {
  DEFAULT_LOOKBACK_SLOTS,
  type LookbackFill,
  type LookbackPoint,
  type LookbackTf,
  type LookbackView,
} from "@/lib/fund/lookbackLogic";

const EXIT: Record<string, string> = {
  stop: "止损",
  target: "止盈",
  veto: "RS闸",
  rsWeak: "RPS弱",
  rotate: "置换",
};

type BookOk = { tf: LookbackTf; name: string; view: LookbackView; sparkline?: number[] };
type BookErr = { tf: LookbackTf; name: string; error: string };
export type FundSnapshot = {
  twoHourVersion?: string;
  accounting?: "continuous-v1";
  runId?: string;
  poolKey?: string;
  slots?: number;
  staleReason?: string;
  epochFrom: string;
  epochs?: BookEpochs;
  computedAt: string | null;
  stale: boolean;
  fromCache: boolean;
  books: (BookOk | BookErr)[];
};

function stamp(raw: string): string {
  return raw.replace("T", " ").slice(0, 16);
}

export function FundBoard({
  snapshot, busy = null, error = null, onRefresh, onApply, readOnly = false,
}: {
  snapshot: FundSnapshot | null;
  busy?: "read" | "save" | "run" | null;
  error?: string | null;
  onRefresh?: () => void;
  onApply?: ApplyBookSettings;
  readOnly?: boolean;
}) {
  const books = snapshot?.books ?? [];
  const computedAt = snapshot?.computedAt;
  const stale = snapshot?.stale;
  const [tf, setTf] = useState<LookbackTf>("4h");
  const activeTf = !readOnly || books.some((b) => b.tf === tf) ? tf : books[0]?.tf ?? tf;
  const activeBook = books.find((b) => b.tf === activeTf);
  const from = activeBook && "view" in activeBook ? activeBook.view.since : snapshot ? liveBookEpoch(snapshot, activeTf).from : undefined;
  const [fillsOpen, setFillsOpen] = useState(false);
  const [chartTarget, setChartTarget] = useState<ChartTarget | null>(null);
  const chartRequest = useMemo(
    () => ({ champ: activeTf === "2h" ? "2h-broad" : "4h", index: "SMALLFUND" }), [activeTf],
  );

  return (
    <div className="space-y-6">
      <Group justify="space-between" align="flex-end">
        <Text size="sm" c="dimmed">
          {readOnly ? "历史结果" : snapshot?.accounting ? "连续账本" : "当前账本"} · 起点 {from ?? "—"} · 每笔投入 {(100 / (snapshot?.slots ?? DEFAULT_LOOKBACK_SLOTS)).toFixed(1)}%
          {computedAt ? ` · 缓存 ${computedAt.replace("T", " ").slice(0, 16)}` : ""}
          {busy === "save" ? " · 正在保存配置" : busy === "run" ? " · 正在更新账本，保留上次结果" : ""}
          {snapshot?.runId ? ` · 版本 ${snapshot.runId.slice(0, 8)}` : ""}
        </Text>
        {onRefresh ? <Button size="xs" variant="light" onClick={onRefresh} loading={busy != null}>更新账本</Button> : null}
      </Group>

      {error ? (
        <Alert color="red" variant="light">
          {error}
        </Alert>
      ) : null}

      {stale ? (
        <Alert color="orange" variant="light">
          {snapshot?.staleReason ?? "配置或行情已更新，下面仍是上次保存的结果，请更新账本。"}
        </Alert>
      ) : null}

      {books.length === 0 && busy === "read" ? (
        <Group justify="center" py="xl">
          <Loader size="sm" />
          <Text size="sm" c="dimmed">
            正在读日推缓存
          </Text>
        </Group>
      ) : null}

      {books.length === 0 && busy === "run" ? (
        <Group justify="center" py="xl">
          <Loader size="sm" />
          <Text size="sm" c="dimmed">
            正在更新账本 4 小时和 2 小时，大约一两分钟
          </Text>
        </Group>
      ) : null}

      {books.length === 0 && busy == null ? (
        <Text size="sm" c="dimmed">
          还没有日推缓存。等下次行情日推，或点更新账本。
        </Text>
      ) : null}

      {books.length > 0 || !readOnly ? (
        <Group justify="space-between" gap="sm">
        <SegmentedControl
          size="sm"
          value={activeTf}
          disabled={busy === "save" || busy === "run"}
          onChange={(v) => {
            setTf(v as LookbackTf);
            setFillsOpen(false);
            setChartTarget(null);
          }}
          data={(readOnly ? books : LIVE_BOOKS).map((book) => ({
            value: book.tf,
            label: liveBookName(book.tf),
          }))}
        />
        {!readOnly && onApply ? <BookEpochCard key={activeTf} tf={activeTf} onApply={onApply}
          applying={busy === "save" || busy === "run"} refreshKey={snapshot?.runId} /> : null}
        </Group>
      ) : null}

      {books.map((book) =>
        book.tf !== activeTf ? null : "error" in book ? (
          <Alert key={book.tf} color="red" variant="light" title={liveBookName(book.tf)}>
            {book.error}
          </Alert>
        ) : (
          <LiveBookCard
            key={book.tf}
            name={liveBookName(book.tf)}
            view={book.view}
            sparkline={book.sparkline}
            fillsOpen={fillsOpen}
            onToggleFills={() => setFillsOpen((v) => !v)}
            readOnly={readOnly}
            onOpenChart={(symbol, entryDate) => { if (!readOnly) setChartTarget({ symbol, entryDate: entryDate ?? "" }); }}
          />
        ),
      )}

      <LabSymbolChart target={chartTarget} request={chartRequest} onClose={() => setChartTarget(null)} />
    </div>
  );
}

function LiveBookCard({
  name,
  view,
  sparkline,
  readOnly,
  fillsOpen,
  onToggleFills,
  onOpenChart,
}: {
  name: string;
  readOnly: boolean;
  view: LookbackView;
  sparkline?: number[];
  fillsOpen: boolean;
  onToggleFills: () => void;
  onOpenChart: (symbol: string, entryDate?: string | null) => void;
}) {
  const s = view.stats;
  const fills = [...(view.fills ?? [])].reverse();
  const last = view.curve.at(-1);
  const lastBuys = last?.buys ?? [];
  const lastSells = last?.sells ?? [];
  const curve: LookbackPoint[] =
    view.curve.length >= 2 ? view.curve : curveFromSparkline(sparkline ?? [], view.since, view.asOf);
  const curveHint = readOnly ? "此处保留该版本计算时的净值与成交。" :
    view.curve.length >= 2
      ? "绿买 · 红卖 · 琥珀当天既买又卖。点代码看 K 线。"
      : curve.length >= 2
        ? "旧缓存只有抽样净值。更新账本后会带买卖点。"
        : null;

  return (
    <Card title={`${name} · ${stamp(view.asOf)}`}>
      <div className="mb-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <MetricCard label="累计" value={view.pnl} valueColor={view.equity >= 1 ? "teal.4" : "red.4"} hint={`自 ${view.since}`} />
        <MetricCard
          label={s.ytdYear != null ? `${s.ytdYear} YTD` : "YTD"}
          value={s.ytdPct == null ? "—" : pnlLabel(s.ytdPct)}
          valueColor={s.ytdPct == null ? "gray.0" : s.ytdPct >= 0 ? "teal.4" : "red.4"}
        />
        <MetricCard
          label="CAGR"
          value={`${s.cagr >= 0 ? "+" : ""}${s.cagr.toFixed(1)}%`}
          valueColor={s.cagr >= 0 ? "teal.4" : "red.4"}
          hint="年化"
        />
        <MetricCard label="回撤" value={`${s.dd.toFixed(0)}%`} valueColor="red.4" />
        <MetricCard label="MAR" value={s.mar.toFixed(2)} hint="年化 / 回撤" />
        <MetricCard label="胜率" value={s.winRatePct == null ? "—" : `${s.winRatePct.toFixed(0)}%`} />
        <MetricCard label="均持" value={s.avgHoldings.toFixed(1)} />
        <MetricCard label="敞口" value={`${view.exposurePct.toFixed(0)}%`} hint={`均 ${s.avgExposure.toFixed(0)}%`} />
        <MetricCard label="持仓" value={`${view.rows.length}`} hint={`${s.entries} 笔入场`} />
        <MetricCard label="年换手" value={s.tradesPerYear.toFixed(0)} />
      </div>

      {curve.length >= 2 ? (
        <div className="mb-4">
          <LookbackEquityChart curve={curve} hint={curveHint} />
        </div>
      ) : null}

      {lastBuys.length || lastSells.length ? (
        <Group gap={6} mb="md">
          {lastBuys.map((sym) => (
            <UnstyledButton disabled={readOnly} key={`b-${sym}`} onClick={() => onOpenChart(sym, last?.date)}>
              <Badge size="sm" color="teal" variant="light">
                当根买 {sym}
              </Badge>
            </UnstyledButton>
          ))}
          {lastSells.map((sym) => (
            <UnstyledButton disabled={readOnly} key={`s-${sym}`} onClick={() => onOpenChart(sym, last?.date)}>
              <Badge size="sm" color="red" variant="light">
                当根卖 {sym}
              </Badge>
            </UnstyledButton>
          ))}
        </Group>
      ) : (
        <Text size="xs" c="dimmed" mb="md">
          最新一根没有买卖
        </Text>
      )}

      <Text size="xs" fw={600} c="dimmed" mb="xs">
        当前持仓
      </Text>
      {view.rows.length === 0 ? (
        <Text size="sm" c="dimmed" mb="lg">
          空仓
        </Text>
      ) : (
        <Table striped highlightOnHover mb="lg" fz="sm">
          <Table.Thead>
            <Table.Tr>
              <Table.Th>标的</Table.Th>
              <Table.Th>开仓</Table.Th>
              <Table.Th ta="right">持仓</Table.Th>
              <Table.Th ta="right">开仓价</Table.Th>
              <Table.Th ta="right">浮盈</Table.Th>
              <Table.Th ta="right">仓位</Table.Th>
              <Table.Th ta="right">RPS</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {view.rows.map((row) => (
              <Table.Tr
                key={row.symbol}
                className={readOnly ? undefined : "cursor-pointer"}
                onClick={() => onOpenChart(row.symbol, row.entryDate)}
              >
                <Table.Td fw={600}>
                  <TickerLink symbol={row.symbol} readOnly={readOnly} />
                </Table.Td>
                <Table.Td c="dimmed">{row.entryDate ? stamp(row.entryDate) : "—"}</Table.Td>
                <Table.Td ta="right" ff="monospace">
                  {daysOpenLabel(daysOpenOf(row.entryDate, view.asOf))}
                </Table.Td>
                <Table.Td ta="right" ff="monospace">
                  {row.entryPrice.toFixed(2)}
                </Table.Td>
                <Table.Td ta="right" ff="monospace" c={row.floatPnlPct >= 0 ? "teal.4" : "red.4"}>
                  {row.floatPnlPct >= 0 ? "+" : ""}
                  {row.floatPnlPct.toFixed(1)}%
                </Table.Td>
                <Table.Td ta="right" ff="monospace">
                  {row.weightPct.toFixed(1)}%
                </Table.Td>
                <Table.Td ta="right" ff="monospace">
                  {row.rps == null ? "—" : row.rps.toFixed(0)}
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      )}

      <UnstyledButton onClick={onToggleFills} mb="xs">
        <Text size="xs" fw={600} c="dimmed">
          成交 {fills.length} 笔 {fillsOpen ? "▾" : "▸"}
        </Text>
      </UnstyledButton>
      {fillsOpen ? (
        fills.length === 0 ? (
          <Text size="sm" c="dimmed">
            这段窗口没有成交
          </Text>
        ) : (
          <Table striped highlightOnHover fz="sm">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>时间</Table.Th>
                <Table.Th>方向</Table.Th>
                <Table.Th>标的</Table.Th>
                <Table.Th ta="right">价格</Table.Th>
                <Table.Th ta="right">盈亏</Table.Th>
                <Table.Th>原因</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {fills.map((fill, i) => (
                <FillRow
                  key={`${fill.date}-${fill.side}-${fill.symbol}-${i}`}
                  fill={fill}
                  readOnly={readOnly}
                  onOpenChart={onOpenChart}
                />
              ))}
            </Table.Tbody>
          </Table>
        )
      ) : null}
    </Card>
  );
}

function FillRow({
  fill,
  readOnly,
  onOpenChart,
}: {
  fill: LookbackFill;
  readOnly: boolean;
  onOpenChart: (symbol: string, entryDate?: string | null) => void;
}) {
  const buy = fill.side === "buy";
  return (
    <Table.Tr className={readOnly ? undefined : "cursor-pointer"} onClick={() => onOpenChart(fill.symbol, fill.date)}>
      <Table.Td c="dimmed">{stamp(fill.date)}</Table.Td>
      <Table.Td>
        <Badge size="sm" color={buy ? "teal" : "red"} variant="light">
          {buy ? "买" : "卖"}
        </Badge>
      </Table.Td>
      <Table.Td fw={600}>
        <TickerLink symbol={fill.symbol} readOnly={readOnly} />
      </Table.Td>
      <Table.Td ta="right" ff="monospace">
        {fill.price.toFixed(2)}
      </Table.Td>
      <Table.Td ta="right" ff="monospace" c={fill.pnlPct == null ? undefined : fill.pnlPct >= 0 ? "teal.4" : "red.4"}>
        {fill.pnlPct == null ? "—" : `${fill.pnlPct >= 0 ? "+" : ""}${fill.pnlPct.toFixed(1)}%`}
      </Table.Td>
      <Table.Td c="dimmed">{fill.reason ? (EXIT[fill.reason] ?? fill.reason) : buy ? "开仓" : "—"}</Table.Td>
    </Table.Tr>
  );
}

function TickerLink({ symbol, readOnly }: { symbol: string; readOnly: boolean }) {
  return (
    <span className={readOnly ? "font-mono font-semibold" : "font-mono font-semibold underline decoration-zinc-600 underline-offset-2 hover:text-zinc-100"}>
      {symbol}
    </span>
  );
}
