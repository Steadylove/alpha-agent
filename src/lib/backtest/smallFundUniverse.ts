/**
 * Small Fund V1.0 的 100 只静态标的池。
 *
 * 与 `/lab` 的标普/纳指池的根本区别：那两个是**时点成分**，某日只在当日的指数
 * 成分中选股；这一份是按 2026-08 的认知手工挑出来的固定名单，幸存者偏差拉满。
 *
 * 因此这个池上的绝对收益数字不能当作策略有效性的证据——可信的只有策略与
 * **同池等权买入持有**之差（引擎已并排输出）。二者吃同一批标的、同一个窗口，
 * 选池偏差大体相抵。这与 40 只轮动池是同一类问题，见 docs/spec-conformance.md。
 */

/** 从原始 100 只清单中剔除的标的与理由。 */
export const SMALL_FUND_EXCLUDED = [
  { symbol: "SPX", reason: "指数不可交易，要基准应换 SPY" },
  { symbol: "BTCUSD", reason: "7×24 交易，日期轴与股票不对齐，会污染截面排名" },
  { symbol: "CURE", reason: "Direxion 医疗 3X 杠杆 ETF，ATR 是标的三倍，止损口径失真" },
] as const;

/**
 * 参与回测的 197 只（原 97 + 2026-08 再加 100）。
 * 抓不到价格的（SKHY、SPCX 等）由抓取层跳过，不在这里预先剔除。
 */
export const SMALL_FUND_UNIVERSE: readonly string[] = [
  "QQQ", "GOOG", "NVDA", "AAPL", "MSFT", "META", "AMZN", "TSLA", "TSM", "AVGO",
  "AMD", "MU", "SNDK", "INTC", "CAT", "NBIS", "LITE", "AAOI", "IREN", "RKLB",
  "BE", "ORCL", "GEV", "CRWD", "SKHY", "SPCX", "XOM", "WMT", "WDC", "VRT",
  "V", "TRV", "QCOM", "TER", "TEM", "STX", "SOFI", "SNOW", "SHOP", "SERV",
  "SBUX", "RTX", "RCAT", "POET", "PLTR", "PL", "ASTS", "ONDS", "OKLO", "NOW",
  "NKE", "NFLX", "NEM", "MRVL", "MRK", "MDB", "MCD", "PDD", "MA", "LRCX",
  "LLY", "KTOS", "KO", "JPM", "JNJ", "ISRG", "IBKR", "HUT", "HOOD", "GS",
  "GLW", "GLD", "GE", "IBM", "GDX", "EOSE", "DOW", "DIS", "DELL", "DDOG",
  "CVX", "CRWV", "CRDO", "COIN", "CLSK", "CLS", "CIEN", "CENX", "CEG", "CCJ",
  "BA", "AXTI", "ASML", "APP", "APH", "AMGN", "ALAB",
  "ARM", "KLAC", "AMAT", "MPWR", "ON", "ANET", "PANW", "FTNT", "NET", "ZS",
  "MSTR", "TTD", "HUBS", "PSTG", "BWXT", "SMR", "LUNR", "POWL", "ETN", "VST",
  "TLN", "SMCI", "CDNS", "SNPS", "ADI", "NXPI", "TYL", "FSLR", "ENPH", "AXON",
  "LMT", "NOC", "GD", "TDG", "DE", "URI", "UNP", "CSX", "FDX", "EOG",
  "SLB", "COP", "KMI", "FCX", "SCCO", "LIN", "SHW", "CRH", "VMC", "MLM",
  "ET", "OXY", "MPC", "PSX", "VLO", "ABBV", "TMO", "DHR", "GILD", "VRTX",
  "REGN", "BDX", "PG", "PEP", "COST", "MDLZ", "CL", "NEE", "DUK", "SO",
  "AEP", "SYK", "BSX", "ELV", "CI", "BLK", "BX", "KKR", "APO", "CME",
  "ICE", "SPGI", "MCO", "AXP", "MS", "PGR", "CB", "ARES", "COF", "MMC",
  "AEM", "GOLD", "WPM", "FNV", "ALB", "MP", "PAAS", "AG", "HL", "LAC",
];

/**
 * 兼容旧调用的「全程都在」起点。带版本的区间见 `smallFundPools.membershipForPool`。
 *
 * 引擎的时点成分机制（`engine.inSpan`）不能绕过——
 * `prepareUniverse` 用 `isMember` 决定谁进当日截面，没有区间的标的一天都排不进去。
 */
export const SMALL_FUND_MEMBERSHIP_START = "1900-01-01";

/**
 * 抓取窗口。回测只看近五年，但 EMA676 要 676 根才播种、之后还需约 1300 根递推
 * 才收敛到稳态（种子占比降到 2%，见 data-sources/yahoo.ts 的注释）。
 * 要让窗口**起点**的 Vegas 判断可信，起点之前就得有约 2000 根，故抓 13 年。
 */
export const SMALL_FUND_HISTORY_YEARS = 13;

/** 回测窗口长度。RPS 的 252 根回看与 MACD 预热都落在窗口之前，不占用这五年。 */
export const SMALL_FUND_WINDOW_YEARS = 5;

/**
 * Small Fund 回测默认配置。
 *
 * 与 `/lab` 的 DEFAULT_BACKTEST_CONFIG 刻意分开：那边是标普池网格默认值。
 * 手做纪律：Vegas+RSI、RPS≥40、止损 4、吊灯 5.5、不止盈、一买+二买、持仓等权、单票 15%。
 *
 * `splitDate` 推到窗口之后，五年落进一个输出窗口。
 */
export const SMALL_FUND_FROM = "2021-08-24";
export const SMALL_FUND_TO = "2026-08-24";
/** Alpaca 1H 从 2021 起；窗口与日线对齐，RPS 252 根预热落在窗口之前。 */
export const SMALL_FUND_4H_FROM = "2021-08-24";

export const SMALL_FUND_DEFAULT_CONFIG = {
  from: SMALL_FUND_FROM,
  to: SMALL_FUND_TO,
  splitDate: "2099-01-01",
  rpsMin: 40,
  useBuy1: true,
  useBuy2: true,
  requireRsi: true,
  minRsi: 30,
  requireVegas: true,
  stopMult: 4,
  trailMult: 5.5,
  takeProfitR: null,
  rpsWeightPower: null,
  maxNameWeight: 0.15,
} as const;

/**
 * 与日线同一套纪律，周期不同：Vegas+RSI、不设 RPS 门槛、止损 8、吊灯 10、不止盈、等权、单票 15%。
 *
 * 这一档是 4H 数据补到 2016 之后在 576 组网格上重选的。此前的 5/6/门槛10 选自只有
 * 2021 起点的数据，那时 Vegas 676 根慢线未播种、`vegasOk` 恒为 0，4H 被迫空仓到
 * 2022-05，整段缺席 2022 熊市跌段——参数是在一段"没有熊市的历史"上挑的。
 * 补数据后旧档在三段最差榜上排 56/576。详见 docs/spec-conformance.md 的口径审计一节。
 */
export const SMALL_FUND_4H_DEFAULT_CONFIG = {
  from: SMALL_FUND_4H_FROM,
  to: SMALL_FUND_TO,
  splitDate: "2099-01-01",
  // 门槛归零。此前认为"剔除最弱一小撮仍有价值"是坏数据下的结论：补数据后只要抬到 5
  // 三段最差就从 1.77 掉到 1.32，到 30 掉到 0.86。4H 的收益本就大量来自深度回撤后的
  // 反弹，那些票当时 RPS 不高，一卡就没了。
  rpsMin: 0,
  useBuy1: true,
  useBuy2: true,
  requireRsi: true,
  minRsi: 30,
  requireVegas: true,
  // 止损 7 以上是平台（三段最差 1.77/1.77/1.79/1.79），9 往上因吊灯先触发而饱和。
  // 吊灯 10 是孤峰：邻居 9 是 1.26、12 是 1.33，所以实盘预期该按 1.3~1.5 折算，别按 1.77。
  stopMult: 8,
  trailMult: 10,
  takeProfitR: null,
  rpsWeightPower: null,
  maxNameWeight: 0.15,
  timeframe: "4h",
} as const;

