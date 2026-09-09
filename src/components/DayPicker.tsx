"use client";

import { DatePickerInput } from "@mantine/dates";

function dayOf(value: unknown): string {
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 10);
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    const y = value.getFullYear();
    const m = String(value.getMonth() + 1).padStart(2, "0");
    const d = String(value.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  return "";
}

export function DayPicker({
  label,
  value,
  onChange,
  size = "sm",
  w = 180,
  withinPortal = true,
}: {
  label?: string;
  value: string;
  onChange: (day: string) => void;
  size?: "xs" | "sm";
  w?: number | string;
  withinPortal?: boolean;
}) {
  return (
    <DatePickerInput
      label={label}
      value={value || null}
      onChange={(next) => onChange(dayOf(next))}
      valueFormat="YYYY-MM-DD"
      placeholder="选择日期"
      clearable={false}
      size={size}
      w={w}
      popoverProps={{ width: 308, withinPortal, shadow: "md" }}
    />
  );
}
