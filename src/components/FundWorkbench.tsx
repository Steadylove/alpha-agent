"use client";

import { useState } from "react";
import { SegmentedControl } from "@mantine/core";

import { FundBoard } from "@/components/FundBoard";
import { LookbackCard } from "@/components/LookbackCard";
import { SignalPoolCard } from "@/components/SignalPoolCard";

type Tab = "live" | "lookback";

export function FundWorkbench() {
  const [tab, setTab] = useState<Tab>("live");
  const [scratch, setScratch] = useState<string[] | null>(null);
  const [restore, setRestore] = useState<{ token: number; members: string[] } | null>(null);

  return (
    <div className="space-y-6">
      <SegmentedControl
        size="sm"
        fullWidth
        value={tab}
        onChange={(v) => setTab(v as Tab)}
        data={[
          { value: "live", label: "当前应用" },
          { value: "lookback", label: "历史回看" },
        ]}
      />
      <div className={tab === "live" ? "space-y-6" : "hidden"}>
        <SignalPoolCard />
        <FundBoard />
      </div>
      <div className={tab === "lookback" ? "space-y-6" : "hidden"}>
        <SignalPoolCard
          mode="scratch"
          restoreMembers={restore?.members}
          restoreToken={restore?.token}
          onMembersChange={setScratch}
        />
        <LookbackCard
          members={scratch}
          onRestore={(members) => setRestore({ token: Date.now(), members })}
        />
      </div>
    </div>
  );
}
