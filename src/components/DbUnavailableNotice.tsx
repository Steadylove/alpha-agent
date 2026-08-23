import { isDbReachable } from "@/lib/db/health";
import { DatabaseZap } from "lucide-react";

/**
 * 数据库不可达时的全站提示条。
 *
 * 存在的理由：库连不上时看板页的只读查询会退化成空结果（见 lib/db/degrade.ts），
 * 页面因此显示「数据生成中」。那个文案在这种情况下是误导——数据不是在生成，
 * 是根本没读到。这条提示把两者区分开。
 */
export async function DbUnavailableNotice() {
  if (await isDbReachable()) return null;

  return (
    <div
      className="mx-auto mt-6 flex max-w-6xl items-start gap-3 rounded-xl border px-4 py-3"
      style={{
        borderColor: "rgba(245,158,11,0.35)",
        background: "linear-gradient(180deg, rgba(245,158,11,0.10), rgba(245,158,11,0.02))",
      }}
    >
      <DatabaseZap className="mt-0.5 h-4 w-4 shrink-0" style={{ color: "#f59e0b" }} />
      <div className="text-sm leading-relaxed">
        <span className="font-medium text-amber-300">数据库暂时不可用</span>
        <span className="text-zinc-400">
          ，看板页显示的空状态不代表真实市场情况。调参实验室 <code>/lab</code>{" "}
          走本地面板缓存，不受影响。
        </span>
      </div>
    </div>
  );
}
