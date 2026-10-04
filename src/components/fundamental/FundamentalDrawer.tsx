"use client";

import { useEffect, useState } from "react";
import { Card } from "@/components/Card";
import type { FundamentalPageData } from "@/lib/fundamental/types";
import { FundamentalPanel } from "./FundamentalPanel";
import { fundamentalEntryAt, fundamentalUrl } from "./entryContext";
import s from "./fundamental.module.css";

export function FundamentalDrawer({ symbol, entryAt, contextLabel, onClose }: { symbol: string; entryAt?: string | null; contextLabel?: string; onClose: () => void }) {
  const at = fundamentalEntryAt(entryAt);
  const url = fundamentalUrl(symbol, at, true);
  const [result, setResult] = useState<{ url: string; data: FundamentalPageData } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(url, { signal: controller.signal, cache: "no-store" });
        if (!response.ok) throw new Error("Snapshot unavailable");
        const data = await response.json() as FundamentalPageData;
        if (!controller.signal.aborted) setResult({ url, data });
      } catch {
        if (!controller.signal.aborted) setResult({ url, data: { symbol, state: null, history: [], entryAt: at, atEntry: null, error: "暂时无法读取估值" } });
      }
    })();
    return () => controller.abort();
  }, [symbol, at, url]);
  return <Card>
    <div className={s.drawerActions}><button type="button" className={s.close} onClick={onClose}>收起 {symbol} 估值</button></div>
    {contextLabel && <p className={s.muted}>{contextLabel} · 仅核对该时点可知信息</p>}
    {result?.url === url ? <FundamentalPanel key={url} data={result.data} /> : <p className={s.loader} role="status">正在读取 {symbol} 已保存的估值…</p>}
    <a className={s.link} href={`${fundamentalUrl(symbol, at)}${at ? "#entry-valuation" : ""}`}>打开完整估值页面 ↗</a>
  </Card>;
}
