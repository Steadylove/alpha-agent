"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Checkbox,
  Group,
  Modal,
  NumberInput,
  ScrollArea,
  SegmentedControl,
  Text,
  Textarea,
  TextInput,
  UnstyledButton,
} from "@mantine/core";

import { Card } from "@/components/Card";
import { DayPicker } from "@/components/DayPicker";
import { LabSymbolChart, type ChartTarget } from "@/components/LabSymbolChart";
import type { LookbackPickTf } from "@/lib/fund/lookbackPickLogic";
import { LOOKBACK_RECOMMEND_2H, LOOKBACK_RECOMMEND_4H } from "@/lib/fund/lookbackRecommend";
import {
  applySignalPool,
  baseOfPool,
  editSignalPoolMany,
  emptySignalPool,
  parseTickers,
  replaceSignalPool,
  type SignalPoolPatch,
} from "@/lib/fund/signalPoolLogic";

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

function asDraft(pool: Pick<Pool, "added" | "removed">): SignalPoolPatch {
  return { added: [...pool.added], removed: [...pool.removed], updatedAt: "" };
}

function sameDraft(a: SignalPoolPatch, b: Pick<Pool, "added" | "removed">): boolean {
  return a.added.join() === b.added.join() && a.removed.join() === b.removed.join();
}

export function SignalPoolCard({
  mode = "live",
  onMembersChange,
}: {
  mode?: "live" | "scratch";
  onMembersChange?: (members: string[]) => void;
}) {
  const scratch = mode === "scratch";
  const [saved, setSaved] = useState<Pool | null>(null);
  const [draft, setDraft] = useState<SignalPoolPatch | null>(null);
  const [ticker, setTicker] = useState("");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [listOpen, setListOpen] = useState(false);
  const [chartTarget, setChartTarget] = useState<ChartTarget | null>(null);
  const [chartChamp, setChartChamp] = useState<ChartChamp>("4h");
  const [pickFrom, setPickFrom] = useState("2026-01-01");
  const [pickTo, setPickTo] = useState("");
  const [pickN, setPickN] = useState<number | string>(10);
  const [pickTf, setPickTf] = useState<LookbackPickTf>("4h");
  const [picking, setPicking] = useState(false);
  const [showRemoved, setShowRemoved] = useState(false);
  const chartRequest = useMemo(() => ({ champ: chartChamp, index: "SMALLFUND" }), [chartChamp]);

  const load = useCallback(async () => {
    const res = await fetch("/api/signal-pool");
    const json = await res.json();
    if (!res.ok) throw new Error(json.error ?? "读取池子失败");
    const pool = json as Pool;
    setSaved(pool);
    setDraft(asDraft(pool));
  }, []);

  useEffect(() => {
    void load().catch((e: unknown) => setError(e instanceof Error ? e.message : "读取失败"));
  }, [load]);

  const defaults = useMemo(() => (saved ? baseOfPool(saved) : []), [saved]);
  const members = useMemo(
    () => (draft ? applySignalPool(defaults, draft) : saved?.members ?? []),
    [defaults, draft, saved],
  );
  const addedSet = useMemo(() => new Set(draft?.added ?? []), [draft]);
  const missingSet = useMemo(() => new Set(saved?.missingCsv ?? []), [saved]);
  const dirty = Boolean(saved && draft && !sameDraft(draft, saved));

  useEffect(() => {
    if (!saved || !draft) return;
    onMembersChange?.(members);
  }, [saved, draft, members, onMembersChange]);

  const hits = useMemo(() => {
    const q = query.trim().toUpperCase();
    if (!q) return members;
    return members.filter((s) => s.includes(q));
  }, [members, query]);

  const removedHits = useMemo(() => {
    const removed = draft?.removed ?? [];
    const q = query.trim().toUpperCase();
    if (!q) return removed;
    return removed.filter((s) => s.includes(q));
  }, [draft, query]);

  const removedShown = query.trim() || showRemoved ? removedHits : [];
  const visible = useMemo(() => [...removedShown, ...hits], [removedShown, hits]);
  const selectedIn = hits.filter((s) => selected.has(s));
  const selectedOut = removedHits.filter((s) => selected.has(s));

  const openChart = (symbol: string) => {
    setListOpen(true);
    setChartTarget({ symbol, entryDate: "" });
  };

  const patchDraft = (next: SignalPoolPatch) => {
    setDraft(next);
    setError(null);
  };

  const applyLocal = (action: "add" | "remove", codes: string[]) => {
    if (!draft || codes.length === 0) return;
    patchDraft(editSignalPoolMany(defaults, draft, action, codes));
    setSelected((prev) => {
      const next = new Set(prev);
      for (const s of codes) next.delete(s);
      return next;
    });
  };

  const submitPaste = (action: "add" | "remove") => {
    const { ok, bad } = parseTickers(ticker);
    if (bad.length) setError(`无法识别：${bad.join(" ")}`);
    else setError(null);
    applyLocal(action, ok);
    if (ok.length) setTicker("");
  };

  const applyRecommend = (tickers: readonly string[]) => {
    patchDraft(replaceSignalPool(defaults, tickers));
    setSelected(new Set());
    setShowRemoved(false);
    setListOpen(true);
  };

  const findBest = async () => {
    if (!saved || !pickFrom) return;
    setPicking(true);
    setError(null);
    try {
      const res = await fetch("/api/lookback", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "pick",
          from: pickFrom,
          to: pickTo || undefined,
          n: pickN,
          tf: pickTf,
        }),
      });
      const json = (await res.json()) as { error?: string; members?: string[] };
      if (!res.ok) throw new Error(json.error ?? "查找失败");
      const picked = json.members ?? [];
      if (picked.length === 0) throw new Error("这段窗口没有实际持仓");
      patchDraft(replaceSignalPool(defaults, picked));
      setSelected(new Set());
      setShowRemoved(false);
      setListOpen(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "查找失败");
    } finally {
      setPicking(false);
    }
  };

  const save = async () => {
    if (scratch) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/signal-pool", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "replace", members }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "写入失败");
      const pool = json as Pool;
      setSaved(pool);
      setDraft(asDraft(pool));
      setConfirmOpen(false);
      setEditing(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "写入失败");
    } finally {
      setBusy(false);
    }
  };

  const toggle = (symbol: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(symbol)) next.delete(symbol);
      else next.add(symbol);
      return next;
    });
  };

  return (
    <Card
      title={scratch ? "临时回看池" : "信号与记账池"}
      action={
        <Group gap={8}>
          {dirty ? (
            <Badge size="sm" color="orange" variant="light">
              {scratch ? "仅本页" : "未保存"}
            </Badge>
          ) : null}
          <Text size="xs" c="dimmed" ff="monospace">
            {saved ? `${members.length} / ${saved.defaultCount}` : ""}
          </Text>
          <Button
            size="compact-sm"
            variant={editing ? "default" : "light"}
            onClick={() => {
              setEditing((v) => !v);
              if (!editing) setListOpen(true);
            }}
          >
            {editing ? "退出编辑" : "编辑"}
          </Button>
        </Group>
      }
    >
      <Text size="sm" c="dimmed" mb="md" lh={1.6}>
        {scratch
          ? "从当前正在跑的池复制一份，只给这次回看用。查找按全池实际持仓贡献取前 N。推荐是 2026 年单票满仓排序后再按 12.5% 账本挑只数最好的一组，事后才知道。不写 Discord。"
          : `默认标普∪纳指扩池 ${saved?.defaultCount ?? "—"} 只。保存后 Discord 买/卖和两本现金账本才改。点代码看策略图。`}
      </Text>
      {scratch ? (
        <Group align="flex-end" wrap="wrap" gap="sm" mb="md">
          <DayPicker label="起点" value={pickFrom} onChange={setPickFrom} />
          <DayPicker label="终点" value={pickTo} onChange={setPickTo} />
          <NumberInput
            size="sm"
            label="尺子只数"
            value={pickN}
            onChange={setPickN}
            min={1}
            max={120}
            w={88}
          />
          <SegmentedControl
            size="sm"
            value={pickTf}
            onChange={(v) => setPickTf(v as LookbackPickTf)}
            data={[
              { value: "4h", label: "4 小时" },
              { value: "2h", label: "2 小时" },
            ]}
          />
          <Button
            size="sm"
            variant="light"
            loading={picking}
            disabled={!pickFrom || !saved}
            onClick={() => void findBest()}
          >
            查找
          </Button>
          <Button
            size="sm"
            variant="default"
            disabled={!saved}
            onClick={() => applyRecommend(LOOKBACK_RECOMMEND_4H)}
          >
            推荐 4H
          </Button>
          <Button
            size="sm"
            variant="default"
            disabled={!saved}
            onClick={() => applyRecommend(LOOKBACK_RECOMMEND_2H)}
          >
            推荐 2H
          </Button>
        </Group>
      ) : null}
      {error ? (
        <Alert color="red" variant="light" mb="sm">
          {error}
        </Alert>
      ) : null}
      {saved && saved.missingCsv.length > 0 ? (
        <Text size="xs" c="orange.4" mb="sm">
          已纳入但缺行情：{saved.missingCsv.join(", ")}。
          {scratch ? "回看也进不了这些票。" : "信号仍会转发，账本要等 CSV 齐了才进。"}
        </Text>
      ) : null}
      {editing ? (
        <>
          <Textarea
            size="sm"
            label="批量标的"
            placeholder="NVDA AAPL，逗号、空格或换行"
            value={ticker}
            onChange={(e) => setTicker(e.currentTarget.value.toUpperCase())}
            autosize
            minRows={1}
            maxRows={4}
            mb="sm"
          />
          <Group wrap="wrap" gap="sm" mb="md">
            <Button size="sm" variant="light" color="teal" disabled={!ticker.trim()} onClick={() => submitPaste("add")}>
              纳入
            </Button>
            <Button size="sm" variant="light" color="red" disabled={!ticker.trim()} onClick={() => submitPaste("remove")}>
              剔除
            </Button>
            <Button
              size="sm"
              variant="light"
              disabled={selectedOut.length === 0}
              onClick={() => applyLocal("add", selectedOut)}
            >
              批量纳入{selectedOut.length ? ` ${selectedOut.length}` : ""}
            </Button>
            <Button
              size="sm"
              variant="light"
              color="red"
              disabled={selectedIn.length === 0}
              onClick={() => applyLocal("remove", selectedIn)}
            >
              批量剔除{selectedIn.length ? ` ${selectedIn.length}` : ""}
            </Button>
            <Button
              size="sm"
              variant="default"
              disabled={!draft || members.length === 0}
              onClick={() => {
                patchDraft({ added: [], removed: [...defaults], updatedAt: "" });
                setSelected(new Set());
              }}
            >
              清空
            </Button>
            <Button
              size="sm"
              variant="default"
              disabled={!draft || sameDraft(draft, emptySignalPool())}
              onClick={() => {
                patchDraft(emptySignalPool());
                setSelected(new Set());
              }}
            >
              恢复默认
            </Button>
            {scratch ? null : (
              <Button size="sm" disabled={!dirty} onClick={() => setConfirmOpen(true)}>
                保存
              </Button>
            )}
          </Group>
        </>
      ) : null}
      {draft && draft.removed.length > 0 && draft.removed.length <= 12 ? (
        <ChipRow label="已剔除">
          {draft.removed.map((s) => (
            <Badge
              key={s}
              variant="light"
              color="red"
              style={{ cursor: "pointer" }}
              onClick={() => openChart(s)}
              rightSection={
                editing ? (
                  <ActionIcon
                    size="xs"
                    color="red"
                    variant="transparent"
                    aria-label={`重新纳入 ${s}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      applyLocal("add", [s]);
                    }}
                  >
                    ×
                  </ActionIcon>
                ) : undefined
              }
            >
              {s}
            </Badge>
          ))}
        </ChipRow>
      ) : null}
      {draft && draft.added.length > 0 ? (
        <ChipRow label="新纳入">
          {draft.added.map((s) => (
            <Badge
              key={s}
              variant="light"
              color="teal"
              style={{ cursor: "pointer" }}
              onClick={() => openChart(s)}
              rightSection={
                editing ? (
                  <ActionIcon
                    size="xs"
                    color="teal"
                    variant="transparent"
                    aria-label={`剔除 ${s}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      applyLocal("remove", [s]);
                    }}
                  >
                    ×
                  </ActionIcon>
                ) : undefined
              }
            >
              {s}
            </Badge>
          ))}
        </ChipRow>
      ) : null}
      {saved ? (
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
              当前名单 · {members.length} 只
              {draft && draft.removed.length > 0 ? ` · 已剔除 ${draft.removed.length}` : ""}
              {editing && selected.size > 0 ? ` · 已选 ${selected.size}` : ""}
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
              {(draft && draft.removed.length > 0) || editing ? (
                <Group gap="sm" mb="sm">
                  {draft && draft.removed.length > 0 ? (
                    <Button
                      size="compact-sm"
                      variant={showRemoved ? "light" : "subtle"}
                      color="red"
                      onClick={() => setShowRemoved((v) => !v)}
                    >
                      {showRemoved ? "只看当前" : `看已剔除 ${draft.removed.length}`}
                    </Button>
                  ) : null}
                  {editing ? (
                    <>
                      <Button
                        size="compact-sm"
                        variant="subtle"
                        disabled={visible.length === 0}
                        onClick={() => setSelected(new Set(visible))}
                      >
                        全选{query.trim() ? "筛选" : ""}
                      </Button>
                      <Button
                        size="compact-sm"
                        variant="subtle"
                        disabled={selected.size === 0}
                        onClick={() => setSelected(new Set())}
                      >
                        取消全选
                      </Button>
                    </>
                  ) : null}
                </Group>
              ) : null}
              <Text size="xs" c="dimmed" mb="sm">
                {editing ? "勾选后批量纳入/剔除。" : ""}点代码打开{" "}
                {chartChamp === "4h" ? "4 小时" : "2 小时"} 策略图：K 线、Vegas、吊灯、一买二买。
              </Text>
              <ScrollArea h={340} type="auto" offsetScrollbars>
                <div className="grid grid-cols-2 gap-x-2 sm:grid-cols-3 md:grid-cols-4">
                  {removedShown.map((s) => (
                    <TickerRow
                      key={`out-${s}`}
                      symbol={s}
                      editing={editing}
                      checked={selected.has(s)}
                      muted
                      tag="已剔除"
                      tagColor="red"
                      actionLabel="纳入"
                      actionColor="teal"
                      onToggle={() => toggle(s)}
                      onOpen={() => openChart(s)}
                      onAction={() => applyLocal("add", [s])}
                    />
                  ))}
                  {hits.map((s) => (
                    <TickerRow
                      key={s}
                      symbol={s}
                      editing={editing}
                      checked={selected.has(s)}
                      tag={addedSet.has(s) ? "新纳入" : missingSet.has(s) ? "缺行情" : undefined}
                      tagColor={addedSet.has(s) ? "teal" : missingSet.has(s) ? "orange" : undefined}
                      actionLabel="剔除"
                      actionColor="red"
                      onToggle={() => toggle(s)}
                      onOpen={() => openChart(s)}
                      onAction={() => applyLocal("remove", [s])}
                    />
                  ))}
                </div>
                {hits.length === 0 && removedShown.length === 0 ? (
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
      <Modal opened={!scratch && confirmOpen} onClose={() => setConfirmOpen(false)} title="保存信号池" centered>
        <Text size="sm" lh={1.6}>
          将池写成 {members.length} 只（默认 {saved?.defaultCount ?? "—"}）。新纳入{" "}
          {draft?.added.length ?? 0} · 剔除 {draft?.removed.length ?? 0}。
          {members.length === 0 ? " 池是空的，Discord 将不转发任何信号。" : ""}
          确认后 Discord 买/卖和两本现金账本都会换成这份名单。
        </Text>
        <Group justify="flex-end" mt="md">
          <Button variant="default" onClick={() => setConfirmOpen(false)}>
            取消
          </Button>
          <Button color="orange" loading={busy} onClick={() => void save()}>
            确认保存
          </Button>
        </Group>
      </Modal>
    </Card>
  );
}

function ChipRow({ label, children }: { label: string; children: ReactNode }) {
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
  editing,
  checked,
  muted,
  tag,
  tagColor,
  actionLabel,
  actionColor,
  onToggle,
  onOpen,
  onAction,
}: {
  symbol: string;
  editing: boolean;
  checked: boolean;
  muted?: boolean;
  tag?: string;
  tagColor?: string;
  actionLabel: string;
  actionColor: string;
  onToggle: () => void;
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
        {editing ? (
          <Checkbox size="xs" checked={checked} onChange={onToggle} aria-label={`选择 ${symbol}`} />
        ) : null}
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
      {editing ? (
        <Button size="compact-xs" variant="subtle" color={actionColor} onClick={onAction}>
          {actionLabel}
        </Button>
      ) : null}
    </Group>
  );
}
