"use client";

import { Accordion } from "@mantine/core";
import type { ReactNode } from "react";

/** Shared keyboard-accessible disclosure for evidence, methods and signal details. */
export function Disclosure({ title, children, className }: {
  title: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Accordion
      className={className}
      classNames={{ control: "ta-disclosure-control", label: "ta-disclosure-label", content: "ta-disclosure-content" }}
      styles={{ item: { background: "transparent", border: 0 } }}
      keepMountedMode="display-none"
    >
      <Accordion.Item value="details">
        <Accordion.Control>{title}</Accordion.Control>
        <Accordion.Panel>{children}</Accordion.Panel>
      </Accordion.Item>
    </Accordion>
  );
}
