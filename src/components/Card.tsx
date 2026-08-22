"use client";

import { Paper, Text, Title, Group } from "@mantine/core";
import type { ReactNode } from "react";

export function Card({
  title,
  children,
  className = "",
  action,
}: {
  title?: ReactNode;
  children: ReactNode;
  className?: string;
  action?: ReactNode;
}) {
  return (
    <Paper p="lg" className={`lift ${className}`}>
      {title ? (
        <Group justify="space-between" mb="md">
          {typeof title === "string" ? (
            <Title order={3} size="h6" fw={600} c="gray.1">
              {title}
            </Title>
          ) : (
            title
          )}
          {action}
        </Group>
      ) : null}
      {children}
    </Paper>
  );
}

export function MetricCard({
  label,
  value,
  hint,
  valueColor = "gray.0",
}: {
  label: string;
  value: string;
  hint?: string;
  valueColor?: string;
}) {
  return (
    <Card>
      <Text size="xs" fw={500} c="dimmed" style={{ letterSpacing: "0.03em" }}>
        {label}
      </Text>
      <Text
        mt={10}
        size="1.75rem"
        fw={600}
        c={valueColor}
        lh={1.1}
        // 等宽字体只给数字用，套在中文上会显得松散别扭
        ff={/^[+\-\d]/.test(value) ? "monospace" : undefined}
      >
        {value}
      </Text>
      {hint ? (
        <Text mt="xs" size="xs" c="dimmed">
          {hint}
        </Text>
      ) : null}
    </Card>
  );
}
