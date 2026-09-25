import { PageHeading } from "@/components/PageHeading";
import { DeskWorkbench, type DeskStrategies } from "@/components/DeskWorkbench";
import { champOf } from "@/lib/fund/champs";

export const metadata = { title: "信号台" };

export const dynamic = "force-dynamic";

function strategySpec(id: "4h" | "2h-broad"): DeskStrategies["4h"] {
  const { config } = champOf(id);
  const rows: [string, string][] = [
    ["初始止损", `${config.stopMult} × ATR`],
    ["吊灯基准", `${config.trailMult} × ATR`],
    ["止盈", config.takeProfitR == null ? "无固定止盈" : `${config.takeProfitR}R`],
    ["RPS 门槛", config.rpsMin > 0 ? `≥ ${config.rpsMin}` : "不设"],
    ["RSI", config.requireRsi ? `≥ ${config.minRsi}` : "不设"],
  ];
  if (config.rpsExit != null) rows.push(["转弱离场", `RPS < ${config.rpsExit}`]);
  if (config.breakevenPct != null) rows.push(["保本触发", `浮盈 ≥ ${config.breakevenPct}%`]);
  if (config.trailTightenPnl) rows.push(["吊灯收紧", `浮盈 ${config.trailTightenPnl.join("% / ")}%`]);
  return { request: { champ: id }, rows };
}

export default async function DeskPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string | string[] }>;
}) {
  const raw = (await searchParams).q;
  const q = Array.isArray(raw) ? (raw[0] ?? "") : (raw ?? "");

  return (
    <div className="space-y-6">
      <PageHeading
        eyebrow="SIGNAL DESK"
        title="信号台"
        english="Signal desk"
        description="现网股票池、现网定档。每只票在 4 小时和 2 小时最新一根的状态，只看不拍板。"
      />
      <DeskWorkbench initialQuery={q} strategies={{ "4h": strategySpec("4h"), "2h": strategySpec("2h-broad") }} />
    </div>
  );
}
