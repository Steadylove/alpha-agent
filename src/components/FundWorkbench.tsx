"use client";

import { useState } from "react";
import { SegmentedControl } from "@mantine/core";

import { BookEpochCard } from "@/components/BookEpochCard";
import { FundBoard } from "@/components/FundBoard";
import { LookbackCard } from "@/components/LookbackCard";
import { SignalPoolCard } from "@/components/SignalPoolCard";

type Tab = "live" | "lookback";

export function FundWorkbench() {
  const [tab, setTab] = useState<Tab>("live");
  const [scratch, setScratch] = useState<string[] | null>(null);

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
        <BookEpochCard />
        <FundBoard />
      </div>
      <div className={tab === "lookback" ? "space-y-6" : "hidden"}>
        <SignalPoolCard mode="scratch" onMembersChange={setScratch} />
        <LookbackCard members={scratch} />
      </div>
    </div>
  );
}
