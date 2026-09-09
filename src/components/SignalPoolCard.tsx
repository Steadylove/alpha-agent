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
  Paper,
  ScrollArea,
  SegmentedControl,
  Select,
  Text,
  Textarea,
  TextInput,
  UnstyledButton,
} from "@mantine/core";

import type { ApplyBookSettings } from "@/components/FundWorkbench";
import { BookEpochCard } from "@/components/BookEpochCard";
import { Card } from "@/components/Card";
import { DayPicker } from "@/components/DayPicker";
import { LabSymbolChart, type ChartTarget } from "@/components/LabSymbolChart";
import type { LookbackPickTf } from "@/lib/fund/lookbackPickLogic";
import { LOOKBACK_RECOMMEND_2H, LOOKBACK_RECOMMEND_4H } from "@/lib/fund/lookbackRecommend";
import { type LookbackSnapshot } from "@/lib/fund/lookbackSnapshotLogic";
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
  revision?: string | null;
  effectiveAt?: string | null;
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
  restoreMembers,
  restoreToken,
  onApply,
  applying = false,
}: {
  mode?: "live" | "scratch";
  onApply?: ApplyBookSettings;
  applying?: boolean;
  onMembersChange?: (members: string[]) => void;
  restoreMembers?: string[];
  restoreToken?: number;
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
  const [snapshots, setSnapshots] = useState<LookbackSnapshot[]>([]);
  const [snapId, setSnapId] = useState<string | null>(null);
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
    // 异步读取外部存储；状态更新在网络请求完成之后。
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load().catch((e: unknown) => setError(e instanceof Error ? e.message : "读取失败"));
  }, [load]);

  useEffect(() => {
    void fetch("/api/lookback-snapshots")
      .then((r) => r.json())
      .then((j) => {
        if (Array.isArray(j.snapshots)) setSnapshots(j.snapshots);
      })
      .catch(() => undefined);
  }, []);

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
  const visible = [...removedShown, ...hits];
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
    if (!draft) return;
    patchDraft(replaceSignalPool(defaults, tickers));
    setSelected(new Set());
    setShowRemoved(false);
    setListOpen(true);
  };

  const pickedSnap = snapshots.find((s) => s.id === snapId) ?? null;

  const loadSnap = () => {
    if (!pickedSnap) return;
    setError(null);
    applyRecommend(pickedSnap.members);
    setEditing(true);
    setListOpen(true);
  };

  const [appliedRestoreToken, setAppliedRestoreToken] = useState<number | undefined>();
  if (restoreToken && restoreMembers?.length && saved && appliedRestoreToken !== restoreToken) {
    setAppliedRestoreToken(restoreToken);
    setDraft(replaceSignalPool(defaults, restoreMembers));
    setSelected(new Set());
    setShowRemoved(false);
    setListOpen(true);
  }

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
      if (!onApply) throw new Error("账本更新入口未就绪");
      await onApply(async () => {
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
      });
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

  const liveOpen = scratch || editing || listOpen;
  const bar = (
    <Group justify="space-between" wrap="wrap" gap="xs">
      <Group gap={6} wrap="wrap">
        <Text size="sm" fw={600} c="gray.2">
          {scratch ? "临时回看池" : "记账池"}
        </Text>
        <Text size="sm" c="dimmed">
          {saved ? `${members.length} 只` : "—"}
          {draft && draft.removed.length > 0 ? ` · 已剔除 ${draft.removed.length}` : ""}
        </Text>
        {scratch ? null : <BookEpochCard onApply={onApply} applying={applying} />}
      </Group>
      <Group gap={8} wrap="nowrap">
        {dirty ? (
          <Badge size="sm" color="orange" variant="light">
            {scratch ? "仅本页" : "未保存"}
          </Badge>
        ) : null}
        {scratch ? (
          <Text size="xs" c="dimmed" ff="monospace">
            {saved ? `${members.length} / ${saved.defaultCount}` : ""}
          </Text>
        ) : (
          <UnstyledButton onClick={() => setListOpen((v) => !v)}>
            <Text size="xs" c="dimmed">
              {listOpen ? "收起名单" : "名单"}
            </Text>
          </UnstyledButton>
        )}
        <Button
          size="compact-xs"
          disabled={applying}
          variant={editing ? "default" : "subtle"}
          onClick={() => {
            setEditing((v) => !v);
            if (!editing) setListOpen(true);
          }}
        >
          {editing ? "退出编辑" : "编辑"}
        </Button>
      </Group>
    </Group>
  );

  const inner = (
    <>
      {scratch ? (
        <Text size="sm" c="dimmed" mb="md" lh={1.6}>
          从当前正在跑的池复制一份，只给这次回看用。查找按全池实际持仓贡献取前 N。推荐是 2026
          年单票满仓排序后再按 12.5% 账本挑只数最好的一组，事后才知道。不写 Discord。
        </Text>
      ) : editing ? (
        <Text size="sm" c="dimmed" mb="md" lh={1.6}>
          修改和载入先保留为草稿；保存后沿用已有现金、持仓和累计成绩，新名单只影响后续信号。
        </Text>
      ) : null}
      {!scratch && saved?.effectiveAt ? <Text size="xs" c="dimmed" mb="sm">池版本 {saved.revision?.slice(0, 8)} · 保存于 {new Date(saved.effectiveAt).toLocaleString("zh-CN")} · 此后新开始的 K 线使用新名单</Text> : null}
      {scratch || editing ? (
        <Group align="flex-end" wrap="wrap" gap="sm" mb="md">
          <Select
            size="sm"
            label="已存股票池"
            placeholder={snapshots.length ? "选一份载入" : "还没有快照"}
            data={snapshots.map((s) => ({
              value: s.id,
              label: `${s.name} · ${s.members.length}只`,
            }))}
            value={snapId}
            onChange={setSnapId}
            searchable
            clearable
            w={280}
          />
          <Button
            size="sm"
            variant="light"
            disabled={!pickedSnap || applying}
            loading={busy && !scratch}
            onClick={() => void loadSnap()}
          >
            载入草稿
          </Button>
        </Group>
      ) : null}
      {scratch ? (
        <Group align="flex-end" wrap="wrap" gap="sm" mb="md">
          <DayPicker label="起点" value={pickFrom} onChange={setPickFrom} />
          <DayPicker label="终点" value={pickTo} onChange={setPickTo} />
          <NumberInput
            size="sm"
            label="只数"
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
      {liveOpen && saved && saved.missingCsv.length > 0 ? (
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
              <Button size="sm" disabled={!dirty || applying} onClick={() => setConfirmOpen(true)}>
                保存并更新
              </Button>
            )}
          </Group>
        </>
      ) : null}
      {liveOpen && draft && draft.removed.length > 0 && draft.removed.length <= 12 ? (
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
      {liveOpen && draft && draft.added.length > 0 ? (
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
      {saved && liveOpen ? (
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
      <Modal opened={!scratch && confirmOpen} onClose={() => setConfirmOpen(false)} title="保存并更新账本" centered>
        <Text size="sm" lh={1.6}>
          将当前 {saved?.members.length ?? 0} 只调整为 {members.length} 只。新增{" "}
          {members.filter((s) => !saved?.members.includes(s)).length} · 移出 {saved?.members.filter((s) => !members.includes(s)).length ?? 0}。
          {members.length === 0 ? " 池是空的，账本将没有可开仓标的。" : ""}
          保存后新开始的 K 线使用新名单；保留已有现金、持仓和累计成绩。移出的股票不再新增买入，已有持仓继续按原策略退出。
        </Text>
        <Text size="sm" mt="sm">相对当前名单，新增：{members.filter((s) => !saved?.members.includes(s)).join(", ") || "无"}</Text>
        <ScrollArea mah={140} mt="xs"><Text size="sm">剔除：{saved?.members.filter((s) => !members.includes(s)).join(", ") || "无"}</Text></ScrollArea>
        <Group justify="flex-end" mt="md">
          <Button variant="default" disabled={busy || applying} onClick={() => setConfirmOpen(false)}>
            取消
          </Button>
          <Button color="orange" loading={busy || applying} onClick={() => void save()}>
            保存并更新
          </Button>
        </Group>
      </Modal>
    </>
  );

  if (scratch) {
    return (
      <Card title={bar}>
        {inner}
      </Card>
    );
  }

  return (
    <Paper px="md" py="sm" className="lift">
      {bar}
      {liveOpen ? <div className="mt-3">{inner}</div> : inner}
    </Paper>
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
