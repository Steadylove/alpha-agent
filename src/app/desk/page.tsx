import { DeskWorkbench } from "@/components/DeskWorkbench";

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
      <div className="rise-in">
        <h1 className="text-3xl font-semibold tracking-tight text-zinc-50">信号台</h1>
        <p className="mt-2 max-w-3xl text-sm leading-relaxed text-zinc-400">
          现网股票池、现网定档。每只票在 4 小时和 2 小时最新一根的状态，只看不拍板。
        </p>
      </div>
      <DeskWorkbench initialQuery={q} />
    </div>
  );
}
