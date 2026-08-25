"use client";

import { useCallback, useEffect, useState } from "react";
import { Button, Group, Table, Text, TextInput } from "@mantine/core";

import { Card } from "@/components/Card";
import type { LiveBookChange } from "@/lib/backtest/liveBookLogic";

type Book = {
  asOf: string;
  members: string[];
  memberCount: number;
  missingCsv: string[];
  changes: LiveBookChange[];
};

export function LiveBookCard({ asOf, onChanged }: { asOf?: string; onChanged?: () => void }) {
  const [book, setBook] = useState<Book | null>(null);
  const [ticker, setTicker] = useState("");
  const [date, setDate] = useState(asOf?.slice(0, 10) ?? new Date().toISOString().slice(0, 10));
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (day?: string) => {
    const q = day ? `?asOf=${day}` : "";
    const res = await fetch(`/api/desk/book${q}`);
    const json = await res.json();
    if (!res.ok) throw new Error(json.error ?? "读取活账本失败");
    setBook(json as Book);
  }, []);

  useEffect(() => {
    const day = asOf?.slice(0, 10);
    if (day) setDate(day);
    void load(day).catch((e: unknown) => setError(e instanceof Error ? e.message : "读取失败"));
  }, [asOf, load]);

  const submit = async (action: "add" | "remove") => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/desk/book", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, ticker, date, reason }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "写入失败");
      if (Array.isArray(json.missingCsv) && json.missingCsv.length > 0) {
        setError(`${ticker.toUpperCase()} 已记账，但缺少 ${json.missingCsv.join("/")} CSV，扫信号还看不到。`);
      }
      setTicker("");
      setReason("");
      await load(date);
      onChanged?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : "写入失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      title="活账本"
      action={
        <Text size="xs" c="dimmed" ff="monospace">
          {book ? `${book.asOf} · ${book.memberCount} 只` : ""}
        </Text>
      }
    >
      <Text size="xs" c="dimmed" mb="sm">
        加减票必须写生效日和理由。人不改买点，人改这份名单。
      </Text>
      <Group gap="xs" align="end" wrap="wrap" mb="md">
        <TextInput
          size="xs"
          label="标的"
          placeholder="NVDA"
          value={ticker}
          onChange={(e) => setTicker(e.currentTarget.value.toUpperCase())}
          w={110}
        />
        <TextInput
          size="xs"
          label="生效日"
          type="date"
          value={date}
          onChange={(e) => setDate(e.currentTarget.value)}
          w={150}
        />
        <TextInput
          size="xs"
          label="理由"
          placeholder="跟哪股钱、为什么踢"
          value={reason}
          onChange={(e) => setReason(e.currentTarget.value)}
          style={{ flex: 1, minWidth: 180 }}
        />
        <Button size="xs" color="teal" variant="light" loading={busy} onClick={() => void submit("add")}>
          纳入
        </Button>
        <Button size="xs" color="red" variant="light" loading={busy} onClick={() => void submit("remove")}>
          剔除
        </Button>
      </Group>
      {error ? (
        <Text size="xs" c="red.4" mb="sm">
          {error}
        </Text>
      ) : null}
      {book && book.missingCsv.length > 0 ? (
        <Text size="xs" c="orange.4" mb="sm">
          在池但无行情：{book.missingCsv.join(", ")}
        </Text>
      ) : null}
      {book && book.changes.length > 0 ? (
        <Table verticalSpacing={4} horizontalSpacing={6} fz="xs">
          <Table.Thead>
            <Table.Tr>
              <Table.Th>生效日</Table.Th>
              <Table.Th>动作</Table.Th>
              <Table.Th>标的</Table.Th>
              <Table.Th>理由</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {book.changes.map((row) => (
              <Table.Tr key={row.id}>
                <Table.Td ff="monospace">{row.date}</Table.Td>
                <Table.Td>{row.action === "add" ? "纳入" : "剔除"}</Table.Td>
                <Table.Td ff="monospace" fw={600}>
                  {row.ticker}
                </Table.Td>
                <Table.Td c="dimmed">{row.reason}</Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      ) : (
        <Text size="xs" c="dimmed">
          还没有人工加减。基线是 V1 原池 + 2026-08-01 扩入的 100 只。
        </Text>
      )}
    </Card>
  );
}
