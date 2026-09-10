"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, Button, Group, Modal, ScrollArea, Select, Table, Text } from "@mantine/core";
import { Card } from "@/components/Card";
import { FundBoard, type FundSnapshot } from "@/components/FundBoard";
import type { LiveBookCache, LiveBookVersion } from "@/lib/fund/liveBooksLogic";
import { liveBookStarts } from "@/lib/fund/liveBooksLogic";

export function BookHistoryCard({ current }: { current: FundSnapshot | null }) {
  const [open, setOpen] = useState(false);
  const [versions, setVersions] = useState<LiveBookVersion[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [book, setBook] = useState<LiveBookCache | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef(0);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/fund/live-books?history=1", { cache: "no-store" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "读取历史失败");
      setVersions(json.versions ?? []);
      setError(null);
    } catch (e) { setError(e instanceof Error ? e.message : "读取历史失败"); }
  }, []);

  useEffect(() => {
    // 弹窗打开或当前版本变化时，异步读取持久化历史。
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (open) void load();
  }, [open, current?.runId, load]);

  const choose = async (id: string | null) => {
    setSelected(id);
    setBook(null);
    setError(null);
    const seq = ++requestId.current;
    if (!id) { setLoading(false); return; }
    setLoading(true);
    try {
      const res = await fetch(`/api/fund/live-books?version=${encodeURIComponent(id)}`, { cache: "no-store" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "读取版本失败");
      if (seq === requestId.current) setBook(json as LiveBookCache);
    } catch (e) {
      if (seq === requestId.current) setError(e instanceof Error ? e.message : "读取版本失败");
    } finally { if (seq === requestId.current) setLoading(false); }
  };

  const changes = useMemo(() => {
    const before = book?.poolKey.split(",").filter(Boolean) ?? [];
    const after = current?.poolKey?.split(",").filter(Boolean) ?? [];
    return { added: after.filter((s) => !before.includes(s)), removed: before.filter((s) => !after.includes(s)) };
  }, [book, current?.poolKey]);

  return (
    <Card title="账本历史" action={<Button size="xs" variant="light" onClick={() => setOpen(true)}>查看版本</Button>}>
      <Text size="sm" c="dimmed">每次成功计算保留当时的名单、起点、持仓、成交和净值。旧三根口径的 2H 成绩已作废，不再展示或继承。</Text>
      <Modal opened={open} onClose={() => setOpen(false)} title="账本历史与当前结果对照" size="xl" centered>
        <Select label="历史版本" placeholder={versions.length ? "选择一个版本" : "还没有保存的版本"} searchable clearable value={selected}
          onChange={(id) => void choose(id)}
          data={versions.map((v) => ({ value: v.id, label: `${v.computedAt.replace("T", " ").slice(0, 19)} · ${liveBookStarts(v)} · ${v.poolKey.split(",").filter(Boolean).length}只 · ${v.id.slice(0, 8)}` }))}
        />
        {error ? <Alert color="red" mt="md">{error}</Alert> : null}
        {loading ? <Text size="sm" mt="md">正在读取历史结果…</Text> : null}
        {book ? (
          <div className="mt-5 space-y-5">
            <Group gap="xl">
              <Text size="sm">历史起点：{liveBookStarts(book)} · 每笔 {(100 / book.slots).toFixed(1)}%</Text>
              <Text size="sm">当前起点：{current ? liveBookStarts(current) : "—"} · 每笔 {(100 / (current?.slots ?? 10)).toFixed(1)}%</Text>
            </Group>
            <ScrollArea mah={130}>
              <Text size="sm">此后纳入：{changes.added.join(", ") || "无"}</Text>
              <Text size="sm" mt="xs">此后剔除：{changes.removed.join(", ") || "无"}</Text>
            </ScrollArea>
            {book.poolHistory ? <details>
              <summary className="cursor-pointer text-sm">截至该版本的池子变更记录</summary>
              {book.poolHistory.map((revision, i) => {
                const before = book.poolHistory?.[i - 1]?.members ?? [];
                const added = revision.members.filter((m) => !before.includes(m));
                const removed = before.filter((m) => !revision.members.includes(m));
                return <Text size="xs" mt="xs" key={revision.id}>
                  {revision.effectiveAt ? new Date(revision.effectiveAt).toLocaleString("zh-CN") : "初始名单"} · {revision.members.length} 只
                  {i > 0 ? ` · 纳入 ${added.join(", ") || "无"} · 移出 ${removed.join(", ") || "无"}` : ""}
                </Text>;
              })}
              <Text size="xs" mt="xs" c="dimmed">变更仅作用于保存后新开始的 K 线，原有持仓继续管理退出。</Text>
            </details> : null}
            <Table fz="xs">
              <Table.Thead><Table.Tr><Table.Th>周期</Table.Th><Table.Th>历史 / 当前截至</Table.Th><Table.Th>累计收益</Table.Th><Table.Th>回撤</Table.Th><Table.Th>持仓数</Table.Th></Table.Tr></Table.Thead>
              <Table.Tbody>{book.books.map((old) => {
                const match = current?.books.find((b) => b.tf === old.tf);
                const now = match && "view" in match ? match.view : null;
                return <Table.Tr key={old.tf}>
                  <Table.Td>{old.name}</Table.Td>
                  <Table.Td>{old.view.asOf.replace("T", " ")}<br />{now?.asOf.replace("T", " ") ?? "—"}</Table.Td>
                  <Table.Td>{old.view.pnl} → {now?.pnl ?? "—"}</Table.Td>
                  <Table.Td>{old.view.stats.dd.toFixed(1)}% → {now ? `${now.stats.dd.toFixed(1)}%` : "—"}</Table.Td>
                  <Table.Td>{old.view.rows.length} → {now?.rows.length ?? "—"}</Table.Td>
                </Table.Tr>;
              })}</Table.Tbody>
            </Table>
            {book.books.map((old) => {
              const match = current?.books.find((b) => b.tf === old.tf);
              const now = match && "view" in match ? match.view : null;
              return <div key={old.tf}>
                <Text size="xs" fw={600}>{old.name} 持仓对照（标的 / 仓位）</Text>
                <Text size="xs" mt={4}>历史：{old.view.rows.map((r) => `${r.symbol} ${r.weightPct.toFixed(1)}%`).join(" · ") || "空仓"}</Text>
                <Text size="xs" mt={4}>当前：{now ? now.rows.map((r) => `${r.symbol} ${r.weightPct.toFixed(1)}%`).join(" · ") || "空仓" : "—"}</Text>
              </div>;
            })}
            <Text size="xs" c="dimmed">下方为历史版本原始结果。起点或截至日期不同时，收益对应不同的计算窗口。</Text>
            <FundBoard snapshot={{ ...book, stale: false, fromCache: true }} readOnly />
          </div>
        ) : null}
      </Modal>
    </Card>
  );
}
