import { PushRoutesBoard } from "@/components/PushRoutesBoard";

export const dynamic = "force-dynamic";

export default function PushPage() {
  return (
    <div className="space-y-6">
      <div className="rise-in">
        <h1 className="text-3xl font-semibold tracking-tight text-zinc-50">推送</h1>
        <p className="mt-2 max-w-3xl text-sm leading-relaxed text-zinc-400">
          管每类信息发不发、发 Discord 还是 Telegram、发到哪个频道。改完立即对下一笔推送生效，不用改环境变量。
        </p>
      </div>
      <PushRoutesBoard />
    </div>
  );
}
