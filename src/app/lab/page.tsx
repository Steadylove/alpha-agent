import { LabWorkbench } from "@/components/LabWorkbench";

/** 结果全靠接口按参数实时算，页面本身没有可缓存的内容。 */
export const dynamic = "force-static";

export default function LabPage() {
  return (
    <div className="space-y-6">
      <div className="rise-in">
        <h1 className="text-3xl font-semibold tracking-tight text-zinc-50">调参实验室</h1>
        <p className="mt-2 max-w-3xl text-sm leading-relaxed text-zinc-400">
          在标普 500 的时点成分池上回测抄底买点：某一天只在当日的指数成分里选股，
          截面 RPS 也只在当日成分之间排名，避免拿今天的赢家名单去跑二十年前。
          每个结果都配一条同池等权买入持有的基准线——单看策略收益说明不了任何事。
        </p>
      </div>

      <LabWorkbench />
    </div>
  );
}
