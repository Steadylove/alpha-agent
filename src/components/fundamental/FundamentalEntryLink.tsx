"use client";

import { fundamentalEntryAt, fundamentalUrl } from "./entryContext";
import s from "./fundamental.module.css";

export function FundamentalEntryLink({ symbol, entryAt, label, onOpen }: { symbol: string; entryAt: string | null; label: string; onOpen?: () => void }) {
  const at = fundamentalEntryAt(entryAt);
  return at ? <a className={s.entryLink} href={`${fundamentalUrl(symbol, at)}#entry-valuation`}
    onClick={event => { event.stopPropagation(); if (onOpen) { event.preventDefault(); onOpen(); } }}>{label}</a>
    : <span className={s.summaryMuted}>{label}：准确时间未留档</span>;
}
