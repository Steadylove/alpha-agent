import { DeskWorkbench } from "@/components/DeskWorkbench";

export const dynamic = "force-dynamic";

export default function DeskPage() {
  return (
    <div className="space-y-6">
      <div className="rise-in">
        <h1 className="text-3xl font-semibold tracking-tight text-zinc-50">信号台</h1>
        <p className="mt-2 max-w-3xl text-sm leading-relaxed text-zinc-400">
          当前池、冻结纪律扫出来的买点。确认或否决并留账。人不改公式，人改池子、拍板。
        </p>
      </div>
      <DeskWorkbench />
    </div>
  );
}
