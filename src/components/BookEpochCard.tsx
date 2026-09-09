"use client";

import { useCallback, useEffect, useState } from "react";
import { Alert, Button, Group, Modal, Popover, Text, UnstyledButton } from "@mantine/core";

import { DayPicker } from "@/components/DayPicker";

type Epoch = { from: string; resetAt: string | null; defaultFrom: string };

export function BookEpochCard() {
  const [epoch, setEpoch] = useState<Epoch | null>(null);
  const [from, setFrom] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [open, setOpen] = useState(false);

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
      setOpen(false);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "重置失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Group gap={6} wrap="nowrap">
      <Text size="sm" c="dimmed">
        自 {epoch?.from ?? "—"} 空仓
      </Text>
      <Popover opened={open} onChange={setOpen} position="bottom-end" shadow="md">
        <Popover.Target>
          <UnstyledButton>
            <Text size="xs" c="dimmed">
              改起点
            </Text>
          </UnstyledButton>
        </Popover.Target>
        <Popover.Dropdown>
          {error ? (
            <Alert color="red" variant="light" mb="sm">
              {error}
            </Alert>
          ) : null}
          <Group align="flex-end" gap="sm">
            <DayPicker label="新起点" value={from} onChange={setFrom} />
            <Button size="xs" variant="subtle" color="gray" onClick={() => setConfirmOpen(true)}>
              重算账本
            </Button>
          </Group>
        </Popover.Dropdown>
      </Popover>
      <Modal opened={confirmOpen} onClose={() => setConfirmOpen(false)} title="改记账起点" centered>
        <Text size="sm">从 {from || "—"} 空仓重跑当前应用和 Discord 账本？</Text>
        <Group justify="flex-end" mt="md">
          <Button variant="default" onClick={() => setConfirmOpen(false)}>
            取消
          </Button>
          <Button color="orange" loading={busy} onClick={() => void reset()}>
            确认
          </Button>
        </Group>
      </Modal>
    </Group>
  );
}
