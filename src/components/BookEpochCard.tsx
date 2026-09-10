"use client";

import { useEffect, useState } from "react";
import { Alert, Button, Group, Modal, Popover, Text } from "@mantine/core";

import type { ApplyBookSettings } from "@/components/FundWorkbench";
import { DayPicker } from "@/components/DayPicker";
import type { LookbackTf } from "@/lib/fund/lookbackLogic";

type Epoch = { from: string; resetAt: string | null; defaultFrom: string };

export function BookEpochCard({ tf, onApply, applying = false, refreshKey }: {
  tf: LookbackTf; onApply: ApplyBookSettings; applying?: boolean; refreshKey?: string;
}) {
  const [epoch, setEpoch] = useState<Epoch | null>(null);
  const [from, setFrom] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    const load = async () => {
      try {
        const res = await fetch(`/api/signal-book?tf=${tf}`, { cache: "no-store", signal: controller.signal });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error ?? "读取记账起点失败");
        if (controller.signal.aborted) return;
        setEpoch(json as Epoch);
        setFrom(json.from);
        setError(null);
      } catch (e) {
        if (!controller.signal.aborted) setError(e instanceof Error ? e.message : "读取失败");
      }
    };
    void load();
    return () => controller.abort();
  }, [tf, refreshKey]);

  const reset = async () => {
    setBusy(true);
    setError(null);
    try {
      if (!onApply) throw new Error("账本更新入口未就绪");
      await onApply(async () => {
        const res = await fetch("/api/signal-book", {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tf, from }),
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
        {tf.toUpperCase()} 起点 {epoch?.from ?? "—"}
      </Text>
      <Popover opened={open} onChange={setOpen} position="bottom-end" shadow="md">
        <Popover.Target>
          <Button size="xs" variant="light" color="orange" disabled={applying || busy} onClick={() => setOpen((v) => !v)}>
            重新记账
          </Button>
        </Popover.Target>
        <Popover.Dropdown>
          {error ? (
            <Alert color="red" variant="light" mb="sm">
              {error}
            </Alert>
          ) : null}
          <Group align="flex-end" gap="sm">
            <DayPicker label={`${tf.toUpperCase()} 新一期起点`} value={from} onChange={setFrom} withinPortal={false} />
            <Button size="xs" variant="light" disabled={!from || !epoch || applying || busy} onClick={() => { setOpen(false); setConfirmOpen(true); }}>
              查看变更
            </Button>
          </Group>
          <Text size="xs" c="dimmed" mt="xs">仅重建 {tf.toUpperCase()}。最晚可选 {epoch?.defaultFrom ?? "最近已收盘交易日"}。</Text>
        </Popover.Dropdown>
      </Popover>
      <Modal opened={confirmOpen} onClose={() => { if (!busy && !applying) setConfirmOpen(false); }} title={`${tf.toUpperCase()} 重新记账`} centered>
        <Text size="sm">{tf.toUpperCase()} 当前自 {epoch?.from ?? "—"} 开始。新一期使用当前股票池，从 {from || "—"} 空仓、初始净值 1 重新计算，原持仓和收益保留在历史版本中。</Text>
        <Text size="sm" mt="sm">{tf === "2h" ? "4H" : "2H"} 继续原起点、持仓和收益。仅调整股票池无需重新记账。</Text>
        {error ? <Alert color="red" mt="sm">{error}</Alert> : null}
        <Group justify="flex-end" mt="md">
          <Button variant="default" disabled={busy || applying} onClick={() => setConfirmOpen(false)}>
            取消
          </Button>
          <Button color="orange" loading={busy || applying} onClick={() => void reset()}>
            确认重建 {tf.toUpperCase()}
          </Button>
        </Group>
      </Modal>
    </Group>
  );
}
