"use client";

import { useCallback, useEffect, useState } from "react";
import { Alert, Button, Group, Modal, Text } from "@mantine/core";

import { Card } from "@/components/Card";
import { DayPicker } from "@/components/DayPicker";

type Epoch = { from: string; resetAt: string | null; defaultFrom: string };

export function BookEpochCard() {
  const [epoch, setEpoch] = useState<Epoch | null>(null);
  const [from, setFrom] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch("/api/signal-book");
    const json = await res.json();
    if (!res.ok) throw new Error(json.error ?? "读取记账起点失败");
    const next = json as Epoch;
    setEpoch(next);
    setFrom(next.defaultFrom);
  }, []);

  useEffect(() => {
    void load().catch((e: unknown) => setError(e instanceof Error ? e.message : "读取失败"));
  }, [load]);

  const reset = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/signal-book", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ from }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "重置失败");
      setConfirmOpen(false);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "重置失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="Discord 现金账本">
      <Text size="sm" c="dimmed" mb="sm">
        现在记账自 {epoch?.from ?? "—"}
        {epoch?.resetAt ? ` · 上次重置 ${epoch.resetAt.slice(0, 16).replace("T", " ")}` : ""}
        。实验室五年窗不动；当前应用和 Discord 现金账本都从这天空仓起步。
      </Text>
      {error ? (
        <Alert color="red" variant="light" mb="sm">
          {error}
        </Alert>
      ) : null}
      <Group align="flex-end">
        <DayPicker label="新起点" value={from} onChange={setFrom} />
        <Button variant="light" color="orange" onClick={() => setConfirmOpen(true)}>
          重新开始记账
        </Button>
      </Group>
      <Modal
        opened={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        title="重新开始记账"
        centered
      >
        <Text size="sm">
          从 {from || "—"} 重新记账？之后 Discord 现金账本从这天空仓起步。
        </Text>
        <Group justify="flex-end" mt="md">
          <Button variant="default" onClick={() => setConfirmOpen(false)}>
            取消
          </Button>
          <Button color="orange" loading={busy} onClick={() => void reset()}>
            确认
          </Button>
        </Group>
      </Modal>
    </Card>
  );
}
