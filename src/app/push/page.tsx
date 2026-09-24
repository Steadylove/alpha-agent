import { PageHeading } from "@/components/PageHeading";
import { PushRoutesBoard } from "@/components/PushRoutesBoard";

export const metadata = { title: "推送" };

export const dynamic = "force-dynamic";

export default function PushPage() {
  return (
    <div className="space-y-6">
      <PageHeading
        eyebrow="NOTIFICATION ROUTES"
        title="推送"
        english="Notifications"
        description="管每类信息发不发、发 Discord 还是 Telegram、发到哪个频道。改完立即对下一笔推送生效，不用改环境变量。"
      />
      <PushRoutesBoard />
    </div>
  );
}
