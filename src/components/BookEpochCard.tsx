"use client";

import { useCallback, useEffect, useState } from "react";
import { Alert, Button, Group, Modal, Popover, Text, UnstyledButton } from "@mantine/core";

import type { ApplyBookSettings } from "@/components/FundWorkbench";
import { DayPicker } from "@/components/DayPicker";

type Epoch = { from: string; resetAt: string | null; defaultFrom: string };

export function BookEpochCard({ onApply, applying = false }: { onApply?: ApplyBookSettings; applying?: boolean }) {
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
    setFrom(next.from);
  }, []);

  useEffect(() => {
    // 异步读取外部存储；状态更新在网络请求完成之后。
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load().catch((e: unknown) => setError(e instanceof Error ? e.message : "读取失败"));
  }, [load]);

  const reset = async () => {
    setBusy(true);
    setError(null);
    try {
      if (!onApply) throw new Error("账本更新入口未就绪");
      await onApply(async () => {
        const res = await fetch("/api/signal-book", {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ from }),
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error ?? "保存起点失败");
        setEpoch((prev) => ({ from: json.from, resetAt: json.resetAt, defaultFrom: prev?.defaultFrom ?? json.from }));
        setFrom(json.from);
        setConfirmOpen(false);
        setOpen(false);
      });
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
          <UnstyledButton disabled={applying} onClick={() => setOpen((v) => !v)}>
            <Text size="xs" c="dimmed">
              新建一期
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
            <DayPicker label="新一期起点" value={from} onChange={setFrom} withinPortal={false} />
            <Button size="xs" variant="subtle" color="gray" disabled={!from || from === epoch?.from || applying} onClick={() => setConfirmOpen(true)}>
              查看变更
            </Button>
          </Group>
        </Popover.Dropdown>
      </Popover>
      <Modal opened={confirmOpen} onClose={() => setConfirmOpen(false)} title="新建一期账本" centered>
        <Text size="sm">当前账本自 {epoch?.from ?? "—"} 开始。新一期从 {from || "—"} 空仓、初始净值 1 开始计算，不继承当前持仓和收益；当前账本保留为历史版本。仅调整股票池无需新建一期。</Text>
        <Group justify="flex-end" mt="md">
          <Button variant="default" onClick={() => setConfirmOpen(false)}>
            取消
          </Button>
          <Button color="orange" loading={busy || applying} onClick={() => void reset()}>
            新建并计算
          </Button>
        </Group>
      </Modal>
    </Group>
  );
}
