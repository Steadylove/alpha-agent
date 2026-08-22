"use client";

import type { MacroPhaseSnapshot } from "@/lib/dashboard/mpr";
import { macroPhaseReading, type MacroReadingTone } from "@/lib/scoring/mprReading";
import { Group, Paper, Stack, Text } from "@mantine/core";
import Link from "next/link";
import { ArrowRight } from "lucide-react";

/**
 * 主题给 Paper 设了内联底色，Tailwind 的类名压不过它，
 * 所以这里的色调必须走 style 才生效。
 */
const TONE_STYLE: Record<MacroReadingTone, { borderColor: string; background: string }> = {
  positive: {
    borderColor: "rgba(16,185,129,0.35)",
    background: "linear-gradient(180deg, rgba(16,185,129,0.10), rgba(16,185,129,0.02))",
  },
  caution: {
    borderColor: "rgba(245,158,11,0.35)",
    background: "linear-gradient(180deg, rgba(245,158,11,0.10), rgba(245,158,11,0.02))",
  },
  warning: {
    borderColor: "rgba(249,115,22,0.35)",
    background: "linear-gradient(180deg, rgba(249,115,22,0.10), rgba(249,115,22,0.02))",
  },
  danger: {
    borderColor: "rgba(244,63,94,0.40)",
    background: "linear-gradient(180deg, rgba(244,63,94,0.12), rgba(244,63,94,0.03))",
  },
};

const TONE_DOT: Record<MacroReadingTone, string> = {
  positive: "#10b981",
  caution: "#f59e0b",
  warning: "#f97316",
  danger: "#f43f5e",
};

const TONE_TEXT: Record<MacroReadingTone, string> = {
  positive: "emerald.4",
  caution: "yellow.4",
  warning: "orange.4",
  danger: "red.4",
};

export function MacroPhaseBanner({ latest }: { latest: MacroPhaseSnapshot | null }) {
  if (!latest) return null;

  const reading = macroPhaseReading(latest);

  return (
    <Paper p="lg" className="lift" style={TONE_STYLE[reading.tone]}>
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <Stack gap={6} style={{ minWidth: 0 }}>
          <Group gap="sm" wrap="wrap">
            <span
              className="h-2 w-2 shrink-0 rounded-full"
              style={{ backgroundColor: TONE_DOT[reading.tone] }}
            />
            <Text size="sm" fw={700} c={TONE_TEXT[reading.tone]}>
              {reading.pathLabel}
            </Text>
            <Text size="sm" c="gray.2">
              {reading.headline}
            </Text>
            <Text size="xs" ff="monospace" c="dimmed">
              Risk {latest.marketRiskScore.toFixed(0)} / 100 · {latest.date}
            </Text>
          </Group>
          <Text size="xs" c="dimmed">
            {reading.detail}
          </Text>
        </Stack>

        <Link
          href="/mpr"
          className="group inline-flex shrink-0 items-center gap-2 rounded-lg border border-[var(--border-subtle)] px-3 py-1.5 text-sm text-zinc-300 transition-colors hover:border-[var(--border-strong)] hover:text-zinc-50"
        >
          查看详情
          <ArrowRight className="h-4 w-4 transition-transform duration-200 group-hover:translate-x-0.5" />
        </Link>
      </div>
    </Paper>
  );
}
