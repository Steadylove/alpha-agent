import { LabWorkbench } from "@/components/LabWorkbench";

/** 结果全靠接口按参数实时算，页面本身没有可缓存的内容。 */
export const dynamic = "force-static";

export default function LabPage() {
  return (
    <div className="space-y-6">
      <div className="rise-in">
        <h1 className="text-3xl font-semibold tracking-tight text-zinc-50">调参实验室</h1>
        <p className="mt-2 max-w-3xl text-sm leading-relaxed text-zinc-400">
          抄底买点回测，权重法。冻结档是 4H 现金账本（止 8 / 吊 10 / 每笔 8% / 不置换），数字只从 scripts/fund-rotate.ts 复现。「袖套 50/50」是已否决的旧实验。绿线策略，灰线同池等权。琥珀线：Small Fund 用 QQQ，标普/纳指用 SPY。
        </p>
      </div>

      <LabWorkbench />
    </div>
  );
}
