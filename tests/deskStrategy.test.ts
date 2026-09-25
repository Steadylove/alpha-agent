import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import DeskPage from "@/app/desk/page";
import { DeskWorkbench } from "@/components/DeskWorkbench";
import { CHAMPS, champOf } from "@/lib/fund/champs";

vi.mock("@/components/DeskWorkbench", () => ({ DeskWorkbench: () => null }));
vi.mock("@/components/PageHeading", () => ({ PageHeading: () => null }));
vi.mock("@/lib/fund/champs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/fund/champs")>();
  return { ...actual, champOf: vi.fn(actual.champOf) };
});

type WorkbenchProps = {
  initialQuery: string;
  strategies: Record<"4h" | "2h", {
    request: { champ: string };
    rows: [string, string][];
  }>;
};

function findWorkbench(node: ReactNode): ReactElement<WorkbenchProps> | undefined {
  if (!isValidElement<{ children?: ReactNode }>(node)) return undefined;
  if (node.type === DeskWorkbench) return node as ReactElement<WorkbenchProps>;
  for (const child of Children.toArray(node.props.children)) {
    const found = findWorkbench(child);
    if (found) return found;
  }
}

async function pageProps() {
  const page = await DeskPage({ searchParams: Promise.resolve({ q: "NVDA" }) });
  const workbench = findWorkbench(page);
  expect(workbench).toBeDefined();
  expect(workbench!.props.strategies).toBeDefined();
  return workbench!.props;
}

beforeEach(() => {
  vi.mocked(champOf).mockReset();
  vi.mocked(champOf).mockImplementation((id) => CHAMPS.find((champ) => champ.id === id) ?? CHAMPS[0]);
});

it("信号台展示现网定档，2H 点图请求完整的 2h-broad 而不再覆盖成旧 6/8 参数", async () => {
  const { initialQuery, strategies } = await pageProps();
  expect(initialQuery).toBe("NVDA");
  expect(strategies["4h"].request).toEqual({ champ: "4h" });
  expect(strategies["2h"].request).toEqual({ champ: "2h-broad" });
  expect(strategies["4h"].rows).toEqual([
    ["初始止损", "4 × ATR"],
    ["吊灯基准", "6 × ATR"],
    ["止盈", "3R"],
    ["RPS 门槛", "≥ 30"],
    ["RSI", "≥ 30"],
  ]);
  expect(strategies["2h"].rows).toEqual(expect.arrayContaining([
    ["初始止损", "4 × ATR"],
    ["吊灯基准", "5 × ATR"],
    ["止盈", "无固定止盈"],
    ["RPS 门槛", "不设"],
    ["RSI", "≥ 30"],
    ["转弱离场", "RPS < 10"],
    ["保本触发", "浮盈 ≥ 5%"],
    ["吊灯收紧", "浮盈 8% / 15%"],
  ]));
});

it("现网定档调整后规格同步更新，不保留客户端手写参数副本", async () => {
  const live = CHAMPS.find((champ) => champ.id === "2h-broad")!;
  vi.mocked(champOf).mockImplementation((id) => id === "2h-broad" ? {
    ...live,
    config: {
      ...live.config,
      stopMult: 9,
      trailMult: 11,
      takeProfitR: 2,
      rpsMin: 40,
      requireRsi: false,
      rpsExit: 15,
      breakevenPct: 7,
      trailTightenPnl: [12, 20],
    },
  } : CHAMPS.find((champ) => champ.id === id) ?? CHAMPS[0]);

  const { strategies } = await pageProps();
  expect(strategies["2h"].request).toEqual({ champ: "2h-broad" });
  expect(strategies["2h"].rows).toEqual(expect.arrayContaining([
    ["初始止损", "9 × ATR"],
    ["吊灯基准", "11 × ATR"],
    ["止盈", "2R"],
    ["RPS 门槛", "≥ 40"],
    ["RSI", "不设"],
    ["转弱离场", "RPS < 15"],
    ["保本触发", "浮盈 ≥ 7%"],
    ["吊灯收紧", "浮盈 12% / 20%"],
  ]));
});
