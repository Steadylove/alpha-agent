import { PageHeading } from "@/components/PageHeading";
import { DeskWorkbench } from "@/components/DeskWorkbench";

export const metadata = { title: "信号台" };

export const dynamic = "force-dynamic";

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
      <DeskWorkbench initialQuery={q} />
    </div>
  );
}
