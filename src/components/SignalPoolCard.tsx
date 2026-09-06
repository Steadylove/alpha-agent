"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Group,
  Modal,
  ScrollArea,
  SegmentedControl,
  Text,
  TextInput,
  UnstyledButton,
} from "@mantine/core";

import { Card } from "@/components/Card";
import { LabSymbolChart, type ChartTarget } from "@/components/LabSymbolChart";

type Pool = {
  members: string[];
  memberCount: number;
  defaultCount: number;
  added: string[];
  removed: string[];
  updatedAt: string | null;
  missingCsv: string[];
};

type ChartChamp = "4h" | "2h-broad";

export function SignalPoolCard() {
  const [pool, setPool] = useState<Pool | null>(null);
  const [ticker, setTicker] = useState("");
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [listOpen, setListOpen] = useState(true);
  const [chartTarget, setChartTarget] = useState<ChartTarget | null>(null);
  const [chartChamp, setChartChamp] = useState<ChartChamp>("4h");
  const chartRequest = useMemo(() => ({ champ: chartChamp, index: "SMALLFUND" }), [chartChamp]);

  const load = useCallback(async () => {
    const res = await fetch("/api/signal-pool");
    const json = await res.json();
    if (!res.ok) throw new Error(json.error ?? "读取池子失败");
    setPool(json as Pool);
  }, []);

  useEffect(() => {
    void load().catch((e: unknown) => setError(e instanceof Error ? e.message : "读取失败"));
  }, [load]);

  const addedSet = useMemo(() => new Set(pool?.added ?? []), [pool]);
  const missingSet = useMemo(() => new Set(pool?.missingCsv ?? []), [pool]);

  const hits = useMemo(() => {
    if (!pool) return [];
    const q = query.trim().toUpperCase();
    if (!q) return pool.members;
    return pool.members.filter((s) => s.includes(q));
  }, [pool, query]);

  const removedHits = useMemo(() => {
    if (!pool) return [];
    const q = query.trim().toUpperCase();
    if (!q) return pool.removed;
    return pool.removed.filter((s) => s.includes(q));
  }, [pool, query]);

  const openChart = (symbol: string) => {
    setListOpen(true);
    setChartTarget({ symbol, entryDate: "" });
  };

  const submit = async (action: "add" | "remove" | "reset", code = ticker) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/signal-pool", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, ticker: code }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "写入失败");
      setPool(json as Pool);
      setTicker("");
      setConfirmOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "写入失败");
    } finally {
      setBusy(false);
    }
  };

  const dirty = (pool?.added.length ?? 0) + (pool?.removed.length ?? 0) > 0;

  return (
    <Card
      title="信号与记账池"
      action={
        <Text size="xs" c="dimmed" ff="monospace">
          {pool ? `${pool.memberCount} / ${pool.defaultCount}` : ""}
        </Text>
      }
    >
      <Text size="sm" c="dimmed" mb="md" lh={1.6}>
        默认标普∪纳指扩池 {pool?.defaultCount ?? "—"}{" "}
        只。Discord 买/卖和两本现金账本都读这份名单；2 小时账本只做其中已有 2H
        行情的票。点代码看策略图。
      </Text>
      {error ? (
        <Alert color="red" variant="light" mb="sm">
          {error}
        </Alert>
      ) : null}
      {pool && pool.missingCsv.length > 0 ? (
        <Text size="xs" c="orange.4" mb="sm">
          已纳入但缺行情：{pool.missingCsv.join(", ")}。信号仍会转发，账本要等 CSV 齐了才进。
        </Text>
      ) : null}
      <Group align="flex-end" wrap="wrap" gap="sm" mb="md">
        <TextInput
          size="sm"
          label="标的"
          placeholder="NVDA"
          value={ticker}
          onChange={(e) => setTicker(e.currentTarget.value.toUpperCase())}
          w={128}
        />
        <Button size="sm" variant="light" color="teal" loading={busy} onClick={() => void submit("add")}>
          纳入
        </Button>
        <Button size="sm" variant="light" color="red" loading={busy} onClick={() => void submit("remove")}>
          剔除
        </Button>
        <Button size="sm" variant="default" disabled={!dirty} onClick={() => setConfirmOpen(true)}>
          恢复默认
        </Button>
      </Group>
      {pool && pool.removed.length > 0 ? (
        <ChipRow label="已剔除" color="red">
          {pool.removed.map((s) => (
            <Badge
              key={s}
              variant="light"
              color="red"
              style={{ cursor: "pointer" }}
              onClick={() => openChart(s)}
              rightSection={
                <ActionIcon
                  size="xs"
                  color="red"
                  variant="transparent"
                  aria-label={`重新纳入 ${s}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    void submit("add", s);
                  }}
                >
                  ×
                </ActionIcon>
              }
            >
              {s}
            </Badge>
          ))}
        </ChipRow>
      ) : null}
      {pool && pool.added.length > 0 ? (
        <ChipRow label="新纳入" color="teal">
          {pool.added.map((s) => (
            <Badge
              key={s}
              variant="light"
              color="teal"
              style={{ cursor: "pointer" }}
              onClick={() => openChart(s)}
              rightSection={
                <ActionIcon
                  size="xs"
                  color="teal"
                  variant="transparent"
                  aria-label={`剔除 ${s}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    void submit("remove", s);
                  }}
                >
                  ×
                </ActionIcon>
              }
            >
              {s}
            </Badge>
          ))}
        </ChipRow>
      ) : null}
      {pool ? (
        <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-sunken)]">
          <UnstyledButton
            onClick={() => setListOpen((v) => !v)}
            aria-expanded={listOpen}
            w="100%"
            px="md"
            py="sm"
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              minHeight: 44,
            }}
          >
            <Text size="sm" fw={600} c="gray.2">
              当前名单 · {pool.memberCount} 只
              {pool.removed.length > 0 ? ` · 已剔除 ${pool.removed.length}` : ""}
            </Text>
            <Text size="xs" c="dimmed">
              {listOpen ? "收起" : "展开"}
            </Text>
          </UnstyledButton>
          {listOpen ? (
            <div className="border-t border-[var(--border-subtle)] px-4 py-3">
              <Group justify="space-between" align="flex-end" wrap="wrap" gap="sm" mb="sm">
                <TextInput
                  size="sm"
                  label="在名单里找"
                  placeholder="NVDA"
                  value={query}
                  onChange={(e) => setQuery(e.currentTarget.value.toUpperCase())}
                  style={{ flex: 1, minWidth: 160 }}
                />
                <SegmentedControl
                  size="xs"
                  value={chartChamp}
                  onChange={(v) => setChartChamp(v as ChartChamp)}
                  data={[
                    { value: "4h", label: "4H 图" },
                    { value: "2h-broad", label: "2H 图" },
                  ]}
                />
              </Group>
              <Text size="xs" c="dimmed" mb="sm">
                点代码打开 {chartChamp === "4h" ? "4 小时" : "2 小时"}{" "}
                策略图：K 线、Vegas、吊灯、一买二买。
              </Text>
              <ScrollArea h={340} type="auto" offsetScrollbars>
                <div className="grid grid-cols-2 gap-x-2 sm:grid-cols-3 md:grid-cols-4">
                  {removedHits.map((s) => (
                    <TickerRow
                      key={`out-${s}`}
                      symbol={s}
                      muted
                      tag="已剔除"
                      tagColor="red"
                      actionLabel="纳入"
                      actionColor="teal"
                      busy={busy}
                      onOpen={() => openChart(s)}
                      onAction={() => void submit("add", s)}
                    />
                  ))}
                  {hits.map((s) => (
                    <TickerRow
                      key={s}
                      symbol={s}
                      tag={
                        addedSet.has(s) ? "新纳入" : missingSet.has(s) ? "缺行情" : undefined
                      }
                      tagColor={addedSet.has(s) ? "teal" : missingSet.has(s) ? "orange" : undefined}
                      actionLabel="剔除"
                      actionColor="red"
                      busy={busy}
                      onOpen={() => openChart(s)}
                      onAction={() => void submit("remove", s)}
                    />
                  ))}
                </div>
                {hits.length === 0 && removedHits.length === 0 ? (
                  <Text size="xs" c="dimmed" py="sm">
                    {query.trim() ? "名单里没有这个代码" : "池是空的"}
                  </Text>
                ) : null}
              </ScrollArea>
            </div>
          ) : null}
        </div>
      ) : null}
      <LabSymbolChart
        target={chartTarget}
        request={chartRequest}
        onClose={() => setChartTarget(null)}
      />
      <Modal opened={confirmOpen} onClose={() => setConfirmOpen(false)} title="恢复默认池" centered>
        <Text size="sm">清掉所有人工加减，回到默认 {pool?.defaultCount ?? "—"} 只？</Text>
        <Group justify="flex-end" mt="md">
          <Button variant="default" onClick={() => setConfirmOpen(false)}>
            取消
          </Button>
          <Button color="orange" loading={busy} onClick={() => void submit("reset")}>
            确认
          </Button>
        </Group>
      </Modal>
    </Card>
  );
}

function ChipRow({
  label,
  children,
}: {
  label: string;
  color: string;
  children: ReactNode;
}) {
  return (
    <Group gap={6} mb="sm">
      <Text size="xs" c="dimmed">
        {label}
      </Text>
      {children}
    </Group>
  );
}

function TickerRow({
  symbol,
  muted,
  tag,
  tagColor,
  actionLabel,
  actionColor,
  busy,
  onOpen,
  onAction,
}: {
  symbol: string;
  muted?: boolean;
  tag?: string;
  tagColor?: string;
  actionLabel: string;
  actionColor: string;
  busy: boolean;
  onOpen: () => void;
  onAction: () => void;
}) {
  return (
    <Group
      justify="space-between"
      wrap="nowrap"
      gap={4}
      px={6}
      py={4}
      className="rounded-md hover:bg-[var(--surface-hover)]"
    >
      <Group gap={6} wrap="nowrap" style={{ minWidth: 0 }}>
        <button
          type="button"
          onClick={onOpen}
          className={`truncate font-mono text-sm font-semibold underline decoration-zinc-600 underline-offset-2 hover:text-zinc-100 ${
            muted ? "text-zinc-500 line-through" : "text-zinc-200"
          }`}
        >
          {symbol}
        </button>
        {tag ? (
          <Badge size="xs" variant="light" color={tagColor}>
            {tag}
          </Badge>
        ) : null}
      </Group>
      <Button size="compact-xs" variant="subtle" color={actionColor} loading={busy} onClick={onAction}>
        {actionLabel}
      </Button>
    </Group>
  );
}
