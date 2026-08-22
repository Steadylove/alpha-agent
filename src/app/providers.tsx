"use client";

import { MantineProvider, createTheme } from "@mantine/core";
import type { ReactNode } from "react";

const FONT =
  "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif";

const theme = createTheme({
  fontFamily: FONT,
  headings: { fontFamily: FONT, fontWeight: "500" },
  primaryColor: "gray",
  defaultRadius: "lg",
  components: {
    Paper: {
      defaultProps: { withBorder: true },
      styles: {
        root: {
          backgroundColor: "var(--surface-raised)",
          borderColor: "var(--border-subtle)",
        },
      },
    },
    Accordion: {
      styles: {
        item: {
          backgroundColor: "var(--surface-raised)",
          borderColor: "var(--border-subtle)",
        },
        control: { transition: "background-color 0.18s var(--ease-out)" },
      },
    },
  },
});

export function Providers({ children }: { children: ReactNode }) {
  return (
    // 全站只有深色一套配色，用 forceColorScheme 就不需要 ColorSchemeScript 注入脚本
    <MantineProvider forceColorScheme="dark" theme={theme}>
      {children}
    </MantineProvider>
  );
}
