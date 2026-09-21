import { permanentRedirect } from "next/navigation";

/** 旧书签进入新的每日复盘，轮动持仓模块已停用。 */
export default function RotationPage() {
  permanentRedirect("/");
}
