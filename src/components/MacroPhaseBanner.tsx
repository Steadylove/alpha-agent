"use client";

import type { MacroPhaseSnapshot } from "@/lib/dashboard/mpr";
import { macroPhaseReading, type MacroReadingTone } from "@/lib/scoring/mprReading";
import { Group, Paper, Stack, Text } from "@mantine/core";
import Link from "next/link";
import { ArrowRight } from "lucide-react";

const TONE_CLASS: Record<MacroReadingTone, string> = {
  positive: "border-emerald-500/30 bg-emerald-500/5",
  caution: "border-amber-500/30 bg-amber-500/5",
  warning: "border-orange-500/30 bg-orange-500/5",
  danger: "border-rose-500/30 bg-rose-500/5",
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
    <Paper p="md" className={`border ${TONE_CLASS[reading.tone]}`}>
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <Stack gap={4} style={{ minWidth: 0 }}>
          <Group gap="sm" wrap="wrap">
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
          className="inline-flex shrink-0 items-center gap-2 text-sm text-zinc-400 hover:text-zinc-50 transition-colors"
        >
          Radar <ArrowRight className="h-4 w-4" />
        </Link>
      </div>
    </Paper>
  );
}
