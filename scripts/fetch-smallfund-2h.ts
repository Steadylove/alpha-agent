import "dotenv/config";
import { CSV_1H_DIR, CSV_2H_DIR } from "@/lib/backtest/csvPanel";
import { rebuildTwoHourCsv } from "@/lib/backtest/rebuildTwoHour";
import { marketDataRoot, writeManifest } from "@/lib/backtest/marketStore";
import { TWO_HOUR_VERSION } from "@/lib/backtest/twoHourVersion";

// 全池从已有 1H 重建，不访问行情供应商，不向旧三根口径追加。
const report = rebuildTwoHourCsv(CSV_1H_DIR, CSV_2H_DIR);
const root = marketDataRoot();
if (root) writeManifest(root);
console.log(`${TWO_HOUR_VERSION}：重建 ${report.length} 只，${report.reduce((sum, r) => sum + r.bars, 0)} 根；输入 ${CSV_1H_DIR}，输出 ${CSV_2H_DIR}`);
