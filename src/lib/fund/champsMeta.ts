export const CHAMP_TABS = [
  {
    id: "4h",
    name: "4 小时",
    note: "",
    label: "止8 吊10 无盈 门0 8% 入收盘 RSI≥30 出场关 不置换",
  },
  {
    id: "4h-broad",
    name: "4H 扩池",
    note: "sf-broad 560 · 扩池搜参，不是 195 冻结档",
    label: "止8 吊6 盈3R 门30 12.5% 入收盘 RSI≥30 出场关 不置换",
  },
  {
    id: "2h",
    name: "2 小时",
    note: "",
    label: "止8 吊10 无盈 门30 12.5% 入收盘 RSI关 出场10 不置换",
  },
  {
    id: "2h-broad",
    name: "2H 扩池",
    note: "sf-broad 560 · 扩池搜参，不是 195 冻结档。Pine 做不到 RPS 出场 10",
    label: "止6 吊8 无盈 门0 12.5% 入每根 RSI≥30 出场10 不置换",
  },
  {
    id: "1d",
    name: "日线",
    note: "",
    label: "止4 吊8 盈3R 门10 12.5% 入收盘 RSI关 出场10 不置换",
  },
  {
    id: "1h",
    name: "1 小时",
    note: "",
    label: "止6 吊8 盈3R 门30 12.5% 入每根 RSI≥50 出场30 置换+0 平收盘",
  },
] as const;

export type ChampId = (typeof CHAMP_TABS)[number]["id"];
