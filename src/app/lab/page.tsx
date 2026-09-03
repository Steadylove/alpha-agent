import { LabWorkbench } from "@/components/LabWorkbench";

/** 结果全靠接口按参数实时算，页面本身没有可缓存的内容。 */
export const dynamic = "force-static";

export default function LabPage() {
  return (
    <div className="space-y-6">
      <div className="rise-in">
        <h1 className="text-3xl font-semibold tracking-tight text-zinc-50">调参实验室</h1>
        <p className="mt-2 max-w-3xl text-sm leading-relaxed text-zinc-400">
          四个周期各用一组最佳参数。点曲线或输入日期看当日收盘持仓。绿线策略，灰线同池等权，琥珀 QQQ。
        </p>
      </div>

      <LabWorkbench />
    </div>
  );
}
