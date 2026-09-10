"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { SegmentedControl } from "@mantine/core";

import { FundBoard, type FundSnapshot } from "@/components/FundBoard";
import { BookHistoryCard } from "@/components/BookHistoryCard";
import { LookbackCard } from "@/components/LookbackCard";
import { SignalPoolCard } from "@/components/SignalPoolCard";

type Tab = "live" | "lookback";
export type ApplyBookSettings = (save?: () => Promise<void>) => Promise<void>;

export function FundWorkbench() {
  const [tab, setTab] = useState<Tab>("live");
  const [scratch, setScratch] = useState<string[] | null>(null);
  const [restore, setRestore] = useState<{ token: number; members: string[] } | null>(null);
  const [snapshot, setSnapshot] = useState<FundSnapshot | null>(null);
  const [busy, setBusy] = useState<"read" | "save" | "run" | null>("read");
  const [error, setError] = useState<string | null>(null);
  const locked = useRef(false);
  const requestId = useRef(0);

  const read = useCallback(async () => {
    if (locked.current) return;
    const id = ++requestId.current;
    try {
      const res = await fetch("/api/fund/live-books", { cache: "no-store" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "读取账本失败");
      if (id === requestId.current) {
        setSnapshot(json as FundSnapshot);
        if (!json.stale) setError(null);
      }
    } catch (e) {
      if (id === requestId.current) setError(e instanceof Error ? e.message : "读取失败");
    } finally {
      if (id === requestId.current) setBusy(null);
    }
  }, []);

  useEffect(() => {
    // 异步读取外部存储；状态更新在网络请求完成之后。
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void read();
    const refreshVisible = () => { if (document.visibilityState === "visible") void read(); };
    const timer = setInterval(refreshVisible, 60_000);
    window.addEventListener("focus", refreshVisible);
    return () => { clearInterval(timer); window.removeEventListener("focus", refreshVisible); requestId.current += 1; };
  }, [read]);

  const apply: ApplyBookSettings = useCallback(async (save) => {
    if (locked.current) throw new Error("账本正在更新，请稍候");
    locked.current = true;
    requestId.current += 1;
    setBusy(save ? "save" : "run");
    setError(null);
    let saved = false;
    try {
      if (save) {
        await save();
        saved = true;
      }
      setSnapshot((prev) => prev ? { ...prev, stale: true, staleReason: "正在按已保存配置更新账本，完成前保留上次结果。" } : prev);
      setBusy("run");
      const res = await fetch("/api/fund/live-books", { method: "POST" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "更新账本失败");
      setSnapshot(json as FundSnapshot);
    } catch (e) {
      const reason = e instanceof Error ? e.message : "更新失败";
      const message = saved ? `配置已保存，账本更新未完成：${reason}。上次结果已保留，可重试。`
        : save ? `未能确认配置保存成功：${reason}。可重试或刷新确认。` : `更新账本失败：${reason}。上次结果已保留，可重试。`;
      if (saved || !save) setSnapshot((prev) => prev ? { ...prev, stale: true, staleReason: "账本更新未完成，当前展示上次保存的结果。" } : prev);
      setError(message);
      throw new Error(message);
    } finally {
      locked.current = false;
      setBusy(null);
    }
  }, []);

  return (
    <div className="space-y-6">
      <SegmentedControl size="sm" fullWidth value={tab} onChange={(v) => setTab(v as Tab)} data={[
        { value: "live", label: "当前应用" }, { value: "lookback", label: "历史回看" },
      ]} />
      <div className={tab === "live" ? "space-y-6" : "hidden"}>
        <SignalPoolCard onApply={apply} applying={busy === "save" || busy === "run"} />
        <FundBoard snapshot={snapshot} busy={busy} error={error} onRefresh={() => void apply().catch(() => {})} onApply={apply} />
        <BookHistoryCard current={snapshot} />
      </div>
      <div className={tab === "lookback" ? "space-y-6" : "hidden"}>
        <SignalPoolCard mode="scratch" restoreMembers={restore?.members} restoreToken={restore?.token} onMembersChange={setScratch} />
        <LookbackCard members={scratch} onRestore={(members) => setRestore({ token: Date.now(), members })} />
      </div>
    </div>
  );
}
