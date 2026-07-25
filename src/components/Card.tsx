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
    <Paper p="md" className={className}>
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
      <Text size="sm" fw={500} c="dimmed">
        {label}
      </Text>
      <Text mt="xs" size="1.75rem" fw={600} c={valueColor} lh={1.1}>
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
