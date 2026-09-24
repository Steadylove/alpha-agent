"use client";

import { MantineProvider, createTheme, type CSSVariablesResolver } from "@mantine/core";
import "@mantine/core/styles.css";
import { DatesProvider } from "@mantine/dates";
import "@mantine/dates/styles.css";
import "dayjs/locale/zh-cn";
import type { ReactNode } from "react";
import controls from "./controls.module.css";

const FONT = '"Chakra Petch", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif';

const cssVariablesResolver: CSSVariablesResolver = () => ({
  variables: {},
  light: {},
  dark: {
    "--mantine-color-body": "var(--surface-base)",
    "--mantine-color-text": "var(--text-primary)",
    "--mantine-color-dimmed": "var(--text-muted)",
    "--mantine-color-default": "var(--surface-raised)",
    "--mantine-color-default-hover": "var(--surface-hover)",
    "--mantine-color-default-color": "var(--text-primary)",
    "--mantine-color-default-border": "var(--border-subtle)",
    "--mantine-color-anchor": "var(--accent)",
  },
});

const theme = createTheme({
  fontFamily: FONT,
  headings: { fontFamily: FONT, fontWeight: "600" },
  primaryColor: "mint",
  primaryShade: 6,
  autoContrast: true,
  defaultRadius: "sm",
  radius: { xs: "3px", sm: "4px", md: "6px", lg: "8px", xl: "12px" },
  colors: {
    dark: ["#e8ece9", "#ced6d1", "#a7b4af", "#7b8984", "#43514e", "#2b3434", "#202b27", "#161c1b", "#121716", "#0c1110"],
    gray: ["#f0f3f0", "#e8ece9", "#ced6d1", "#c2ccc6", "#a7b4af", "#97a09e", "#7b8984", "#43514e", "#2b3434", "#161c1b"],
    mint: ["#f0faf5", "#e1f4eb", "#ccebdc", "#b9e2ce", "#a9dac3", "#a3d8bf", "#9ed6bc", "#83b89f", "#578c73", "#355e4b"],
    teal: ["#effaf5", "#d7f1e2", "#b8e6cc", "#9dddba", "#89d6b0", "#72bd98", "#579f7b", "#427f60", "#305d48", "#213f32"],
    red: ["#fff3f1", "#fce0dd", "#fac4bf", "#f7afa9", "#f59a95", "#df7e7b", "#c06664", "#a25150", "#7e4141", "#5a3032"],
    orange: ["#faf5e9", "#f1e5c9", "#e6d3ac", "#dcc38e", "#d4b77c", "#bea26a", "#a68b57", "#8c7448", "#6f5b38", "#504129"],
    blue: ["#f1f7fa", "#e0edf2", "#c6dce6", "#abcbd9", "#8eb6c9", "#779db0", "#608396", "#4d6b7c", "#3b5261", "#2a3b46"],
  },
  components: {
    InputWrapper: { classNames: { label: controls.label } },
    Select: {
      defaultProps: {
        allowDeselect: false,
        maxDropdownHeight: 260,
        checkIconPosition: "right",
        comboboxProps: { withinPortal: true, zIndex: 300 },
      },
      classNames: { dropdown: controls.dropdown, option: controls.option },
    },
    Popover: {
      defaultProps: { withinPortal: true, zIndex: 300 },
      classNames: { dropdown: controls.dropdown },
    },
    Menu: {
      defaultProps: { withinPortal: true, zIndex: 300 },
      classNames: { dropdown: controls.dropdown },
    },
    DatePickerInput: { defaultProps: { valueFormat: "YYYY-MM-DD" } },
    Input: {
      styles: { input: { backgroundColor: "var(--surface-sunken)", borderColor: "var(--border-strong)" } },
    },
    SegmentedControl: {
      styles: {
        root: { backgroundColor: "var(--surface-sunken)", border: "1px solid var(--border-subtle)" },
        indicator: { backgroundColor: "var(--surface-hover)", boxShadow: "none", border: "1px solid var(--border-strong)" },
      },
    },
    Table: {
      styles: { th: { color: "var(--text-muted)", fontWeight: 500, fontSize: "12px" } },
    },
    Tooltip: { styles: { tooltip: { backgroundColor: "var(--surface-hover)", color: "var(--text-primary)", border: "1px solid var(--border-strong)" } } },
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
    <MantineProvider forceColorScheme="dark" theme={theme} cssVariablesResolver={cssVariablesResolver}>
      <DatesProvider settings={{ locale: "zh-cn", firstDayOfWeek: 1, weekendDays: [0, 6] }}>
        {children}
      </DatesProvider>
    </MantineProvider>
  );
}
