"use client";

import { useCallback, useEffect, useState } from "react";
import { Alert, Badge, Button, Group, Loader, Table, Text } from "@mantine/core";

import { Card, MetricCard } from "@/components/Card";
import { daysOpenLabel, daysOpenOf, pnlLabel } from "@/lib/discord/bookCopy";
import {
  DEFAULT_LOOKBACK_SLOTS,
  type LookbackFill,
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

type BookOk = { tf: LookbackTf; name: string; view: LookbackView };
type BookErr = { tf: LookbackTf; name: string; error: string };
type Snapshot = {
  epochFrom: string;
  computedAt: string | null;
  stale: boolean;
  fromCache: boolean;
  books: (BookOk | BookErr)[];
};

function stamp(raw: string): string {
  return raw.replace("T", " ").slice(0, 16);
}

export function FundBoard() {
  const [from, setFrom] = useState<string | null>(null);
  const [books, setBooks] = useState<(BookOk | BookErr)[]>([]);
  const [computedAt, setComputedAt] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [busy, setBusy] = useState<"read" | "run" | null>("read");
  const [error, setError] = useState<string | null>(null);

  const apply = (json: Snapshot) => {
    setFrom(json.epochFrom);
    setBooks(json.books ?? []);
    setComputedAt(json.computedAt);
    setStale(Boolean(json.stale));
  };

  const refresh = useCallback(async () => {
    setError(null);
    setBusy("run");
    try {
      const res = await fetch("/api/fund/live-books", { method: "POST" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "跑账本失败");
      apply(json as Snapshot);
    } catch (e) {
      setError(e instanceof Error ? e.message : "跑账本失败");
    } finally {
      setBusy(null);
    }
  }, []);

  const load = useCallback(async () => {
    setError(null);
    setBusy((cur) => cur ?? "read");
    try {
      const res = await fetch("/api/fund/live-books");
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "读取账本失败");
      const snap = json as Snapshot;
      apply(snap);
      if ((snap.books ?? []).length === 0) setFrom(snap.epochFrom);
    } catch (e) {
      setError(e instanceof Error ? e.message : "读取账本失败");
    } finally {
      setBusy(null);
    }
  }, [refresh]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="space-y-6">
      <Group justify="space-between" align="flex-end">
        <Text size="sm" c="dimmed">
          当前信号池 · 自 {from ?? "—"} 空仓 · 每笔权益 1/{DEFAULT_LOOKBACK_SLOTS}
          {computedAt ? ` · 缓存 ${computedAt.replace("T", " ").slice(0, 16)}` : ""}
          {busy === "run" ? " · 正在重算" : ""}
        </Text>
        <Button size="xs" variant="light" onClick={() => void refresh()} loading={busy != null}>
          重算
        </Button>
      </Group>

      {error ? (
        <Alert color="red" variant="light">
          {error}
        </Alert>
      ) : null}

      {stale ? (
        <Alert color="orange" variant="light">
          池或记账起点已经变了，下面还是上次日推的结果。下次日推会覆盖，也可以现在重算。
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
            正在重算 4 小时和 2H，大约一两分钟
          </Text>
        </Group>
      ) : null}

      {books.length === 0 && busy == null ? (
        <Text size="sm" c="dimmed">
          还没有日推缓存。等下次行情日推，或点重算。
        </Text>
      ) : null}

      {books.map((book) =>
        "error" in book ? (
          <Alert key={book.tf} color="red" variant="light" title={book.name}>
            {book.error}
          </Alert>
        ) : (
          <LiveBookCard key={book.tf} name={book.name} view={book.view} />
        ),
      )}
    </div>
  );
}

function LiveBookCard({ name, view }: { name: string; view: LookbackView }) {
  const s = view.stats;
  const fills = [...(view.fills ?? [])].reverse();
  const last = view.curve.at(-1);
  const lastBuys = last?.buys ?? [];
  const lastSells = last?.sells ?? [];

  return (
    <Card title={`${name} · ${stamp(view.asOf)}`}>
      <div className="mb-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-6">
        <MetricCard label="累计" value={view.pnl} valueColor={view.equity >= 1 ? "teal.4" : "red.4"} hint={`自 ${view.since}`} />
        <MetricCard
          label={s.ytdYear != null ? `${s.ytdYear} YTD` : "YTD"}
          value={s.ytdPct == null ? "—" : pnlLabel(s.ytdPct)}
          valueColor={s.ytdPct == null ? "gray.0" : s.ytdPct >= 0 ? "teal.4" : "red.4"}
        />
        <MetricCard label="回撤" value={`${s.dd.toFixed(0)}%`} valueColor="red.4" />
        <MetricCard label="胜率" value={s.winRatePct == null ? "—" : `${s.winRatePct.toFixed(0)}%`} />
        <MetricCard label="敞口" value={`${view.exposurePct.toFixed(0)}%`} hint={`均 ${s.avgExposure.toFixed(0)}%`} />
        <MetricCard label="持仓" value={`${view.rows.length}`} hint={`${s.entries} 笔入场`} />
      </div>

      {lastBuys.length || lastSells.length ? (
        <Group gap={6} mb="md">
          {lastBuys.map((sym) => (
            <Badge key={`b-${sym}`} size="sm" color="teal" variant="light">
              当根买 {sym}
            </Badge>
          ))}
          {lastSells.map((sym) => (
            <Badge key={`s-${sym}`} size="sm" color="red" variant="light">
              当根卖 {sym}
            </Badge>
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
              <Table.Tr key={row.symbol}>
                <Table.Td fw={600}>{row.symbol}</Table.Td>
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

      <Text size="xs" fw={600} c="dimmed" mb="xs">
        成交 {fills.length} 笔
      </Text>
      {fills.length === 0 ? (
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
              <FillRow key={`${fill.date}-${fill.side}-${fill.symbol}-${i}`} fill={fill} />
            ))}
          </Table.Tbody>
        </Table>
      )}
    </Card>
  );
}

function FillRow({ fill }: { fill: LookbackFill }) {
  const buy = fill.side === "buy";
  return (
    <Table.Tr>
      <Table.Td c="dimmed">{stamp(fill.date)}</Table.Td>
      <Table.Td>
        <Badge size="sm" color={buy ? "teal" : "red"} variant="light">
          {buy ? "买" : "卖"}
        </Badge>
      </Table.Td>
      <Table.Td fw={600}>{fill.symbol}</Table.Td>
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
