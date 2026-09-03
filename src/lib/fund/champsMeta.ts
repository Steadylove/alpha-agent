export const CHAMP_TABS = [
  {
    id: "4h",
    name: "4 小时",
    note: "",
    label: "止8 吊10 无盈 门0 8% 入收盘 RSI≥30 出场关 不置换",
  },
  {
    id: "2h",
    name: "2 小时",
    note: "",
    label: "止8 吊10 无盈 门30 12.5% 入收盘 RSI关 出场10 不置换",
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
