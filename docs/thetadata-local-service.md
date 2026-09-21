# ThetaData 最小本地服务

用于 alpha-agent 的 SPXW 当日到期期权数据下载及单日铁秃鹰条件复盘。采用官方 Python SDK 直连，无需 Java。服务只监听 `127.0.0.1`。

## 配置与启动

需要 Python 3.12+、uv。密钥放在仓库根目录 `.env.local`，该文件已被 Git 忽略：

```dotenv
THETADATA_API_KEY=你的密钥
```

```bash
npm run theta:setup
npm run theta:test
npm run theta:auth
npm run theta:serve
```

`THETA_PYTHON=/path/to/python3 npm run theta:setup` 可指定解释器。依赖位于 `.cache/thetadata-venv`；不修改全局 Python 环境。

## 下载与复盘

```bash
npm run theta:download -- --date 2026-09-15
npm run theta:replay
```

复盘其他日期时，明确指定对应配置，避免误用默认的 9 月 15 日区间：

```bash
npm run theta:download -- --date 2026-09-14
npm run theta:replay -- --forecast research/options/balder-2026-09-14.json
```

下载仅请求该交易日的 SPXW 同日到期合约，09:30–16:00 美东，一分钟采样。按小时缓存，成功分片可断点续传；不会把空响应认作完成。

数据位于 `data/thetadata/YYYY-MM-DD/`（已忽略，不提交）：

- `contracts.csv`：供应商返回的当日到期合约列表。
- `quotes-*.parquet`：每小时原始报价分片。
- `quotes.parquet`：合并去重的全日链。
- `manifest.json`：行数、时间范围、来源及 SHA256。
- `replay.json` / `replay.md`：完整结果与中文报告。

预测与事先固定的规则位于 `research/options/balder-2026-09-15.json`。目前比较 68% / 95% 区间、10:00 / 10:30 / 11:00 入场、5 / 10 / 20 / 50 点翼宽，持有到 PM 到期。

## alpha-agent 后端调用

```typescript
const response = await fetch('http://127.0.0.1:8765/history/download', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ date: '2026-09-15' }),
});
if (!response.ok) throw new Error(await response.text());
const manifest = await response.json();
```

| 接口 | 用途 |
|---|---|
| `GET /health` | 服务存活及最近一次验证的账号权限；首次请求不主动认证 |
| `POST /auth/refresh` | JSON `{}`；重新认证并返回套餐代码，不返回密钥或账号资料 |
| `POST /history/download` | JSON `{"date":"2026-09-15"}`；下载或命中本地缓存 |
| `GET /history?date=2026-09-15` | 下载清单 |
| `GET /quotes?date=2026-09-15&offset=0&limit=100` | 本地报价分页，最多 1000 行 |
| `POST /replay` | JSON 日期；读取对应预测配置并生成复盘 |

HTTP 下载为同步长请求。本地脚本更适合批量下载；若 Next.js 部署到远程，该服务器的 `127.0.0.1` 不会指向你的 Mac，需要把采集模块部署到相应服务器。此版本没有自动下单。

如果认证成功但期权权限为 FREE（供应商代码 0），下载返回 HTTP 403。需确认套餐付款、生效及密钥所属账号。已是 FREE 的会话在下次下载前会重新认证，开通后无需重启服务；也可主动调用 `/auth/refresh`。

官方说明，昨日数据在美东 00:00–01:45 的午夜维护窗口内不可用（夏令时对应北京时间 12:00–13:45，冬令时为 13:00–14:45）。若此时请求昨天的报价并收到空数据错误，服务返回 HTTP 503 和 `retry_at`，不会把下载标记为成功，也不会生成复盘收益。稍后重新执行下载命令即可；该时间只是文档给出的重试参考，不保证实际恢复。更早日期的空数据不会被解释成这次维护。

2026-09-16 北京时间约 12:49 实测：付费权限代码 1 生效；9 月 14 日、9 月 11 日的 10:00–10:02 SPXW 分钟报价分别返回 1,464 和 1,890 行。9 月 15 日列出了 484 个当日到期合约，但报价在此维护窗口内仍返回无数据；尚不能生成该日的实际收益报告。

## 计算与数据限制

### 多日蝶式 / 铁秃鹰复盘

网站公开区间快照保存在 `research/options/balder-ledger-2026-09-16.json`，固定研究规则保存在 `research/options/balder-multiday-rules.json`。

```bash
npm run theta:batch -- download
npm run theta:batch -- replay
```

下载最多两个并发请求，每天只采集美东 10:00、10:30、11:00 三个时刻的完整 SPXW 当日到期链，并验证日期、到期日、重复合约和三个采样时刻。逐日缓存可复用，失败不会被当作零收益日。输出位于 `data/thetadata/balder-multiday/`：`report.md`、`results.json`、`summary.csv`、`daily-trades.csv`。

每个参数序列分别按每天一组统计；不同参数组合不是独立样本，也不代表同一账户同时持仓。回撤仅按每日结算净损益累计计算。蝶式为区间中点的买入看涨蝶式，比较覆盖区间及固定 35 / 50 / 100 点翼宽。铁秃鹰比较 5 / 10 / 20 / 50 点翼宽，另列双侧权利金各自覆盖费用的过滤对照。

### 铁秃鹰报价过滤、风险预算与盘中退出

固定研究参数位于 `research/options/balder-optimization-v1.json`。历史 38 天已经查看过，因此本轮是探索研究，不能称为样本外验证。下载首次运行时在输出目录登记参数内容、时间及哈希，后续修改规则需另开版本。

```bash
npm run theta:optimize -- download
npm run theta:optimize -- replay --capital 20000 --risk-pct 1
.cache/thetadata-venv/bin/python services/theta/audit_optimize.py
.cache/thetadata-venv/bin/python services/theta/plot_optimize.py
```

下载仅针对开仓时符合原规则的候选合约，最多两个并发请求。缓存覆盖 10:00–15:59，每分钟一条；与既有 10:00 快照交叉核验，不重复下载整条期权链。本轮共 268 个合约、96,480 条分钟报价。

规则独立比较 68% / 95% 区间、10 / 20 点翼宽、三种报价过滤，以及持有到期、15:30 退出、止盈 50%、止盈加止损四种退出方式。止盈止损触发后，最早下一分钟按有效买卖盘及挂单量成交，未成交则保持退出请求，最终可以回退到到期结算。零买价的多头翼留到期并计算其内在价值，费用按实际关闭的腿数计算。

`--capital` 与 `--risk-pct` 只改变账户演示，不修改登记的选仓/退出规则。每笔按当前已结算净值限制最大损失准备，合约组数向下取整，同时约束现金与开仓盘口量；不能满足一组风险预算就跳过。另列每次一组及 10 万美元资金敏感性结果，不能将美元盈亏直接当作同本金收益率。

输出在 `data/thetadata/balder-optimization-v1/`：

- `report.md`、`comparison.png`：中文完整报告与累计损益图。
- `results.json`、`summary.csv`：所有规则、成本压力、账户对照和逐笔现金流。
- `minute-marks.json`：分钟盘口估值路径，包含退出后仍持有的保护翼；与逐日已结算回撤分列。
- `download-status.json`、`registered-plan.json`、`audit.json`：原始数据哈希、规则登记及独立核算证据。

首轮结果：68% 区间、10 点翼宽的原规则，从持有到期改为 15:30 退出，每组累计净利润 $846 → $1,507，逐日回撤 $836 → $391；但 95% 区间同样改动降低利润。固定止损在部分序列中反而恶化结果。主账户演示若为 2 万美元、1% 单笔风险，则这些候选全部无法开仓。上述均不是未来收益保证。

### 自建每日收盘区间模型 v1

已将期权隐含模型定为主方法，盘前历史波动模型作为对照，误差校准模型作为实验版。完整约定见 [SPX 收盘区间计算方法 v1](spx-range-method-v1.md)。`npm run theta:forecast -- method` 查看方法编号、固定参数和代码校验状态；公式已独立到 `services/theta/range_model.py`，评估及生成新预测前会检查登记哈希。

不依赖博主区间生成预测。规则在 `research/options/self-forecast-v1.json`，实现为 `services/theta/forecast.py`：

- 盘前基准：仅用目标日前最后 60 个完整日收益，计算收盘区间。
- 10:00 期权基准：完整 SPXW 同日到期链的平值附近 Call/Put 平价中心及 Black 总波动率；区间是定价模型参考，不是已验证实际概率。
- 历史误差校准：仅用此前已结算日期的标准化误差，至少 20 天。该金融时间序列校准不承诺共形预测的严格覆盖保证。

```bash
npm run theta:forecast -- daily
npm run theta:forecast -- evaluate
npm run theta:forecast -- issue --date 2026-09-16 --mode preopen
# 美东 10:00 后且该报价实际可获得时：
npm run theta:forecast -- issue --date 2026-09-16 --mode 10am --download
.cache/thetadata-venv/bin/python services/theta/audit_forecast.py
```

输出位于 `data/thetadata/self-forecast-v1/`。`evaluation.json` 保留逐日期权输入和训练日期，`report.md` 对照覆盖率、区间宽度与区间评分；`issued/` 用实际生成时间创建独立文件，历史重建与事前生成分开标注。输入日线按哈希归档到 `sources/`。尚未设置自动定时运行，也未将自建区间自动转为订单。

现有 38 天已用于探索。两天的平值报价未通过固定质量门槛，期权模型输出 36 天；误差校准预热后只有 16 天。不能从这个样本宣称稳定盈利或优于博主。新日期由调用方确认交易所假期及收盘时刻；盘前与开盘后模型信息集不同，区间均针对最终收盘而非盘中高低点。

#### 历史覆盖率与过拟合检查

```bash
.cache/thetadata-venv/bin/python services/theta/validate_forecast.py
```

固定 v1 参数，使用本地缓存扩展盘前滚动评估；逐日篡改目标日/未来价格确认预测不变，同时从原始 10:00 快照重建期权预测与历史误差校准。输出 `accuracy.json`、`accuracy-report.md`、`accuracy.png`，包含每月覆盖、全部漏报、相同日期比较、区间宽度和小样本不确定性说明。

2026-09-16 的检查使用 304 个日收盘，61 天热身后可评估 243 天（2025-09-26 至 2026-09-15）。盘前 68% / 95% 区间分别覆盖 175/243、226/243；近期 10:00 期权模型分别为 28/36、35/36。两者评估时期不同，不能直接排名。时间截断检查通过不代表排除了模型选择过拟合；新增历史也属于回溯检查，不能改称严格独立测试集。

### PDE-E01：分布到组合现金流

固定实验规则位于 `research/options/pde-e01.json`。读取 v1 的 `F` 与总波动 `w`，在 `density.py` 中提供对数正态 CDF、分位数、区间概率、截断一阶矩和定义风险组合的解析积分；不改动冻结的区间公式。

```bash
npm run theta:pde -- smoke  # 本地前 3 天，先跑合成负对照
npm run theta:pde -- run    # 现有 38 天，输入/代码哈希相同时复用结果
.cache/thetadata-venv/bin/python services/theta/audit_pde.py
npm run theta:test
```

7 种固定候选为 35 点翼宽看涨蝶式、68% / 95% 区间的 10 点翼宽铁秃鹰、两种 68% 边界的 10 点信用价差，以及两种平值附近的 10 点借记价差。每个候选分别计算一组，不把重叠组合相加当成账户表现。报价不合格跳过，不用后续报价补齐。候选与指标生成完毕后才附加当日收盘结果。

输出在 `data/thetadata/pde-e01/`：`report.md`、`results.json`、`registered-plan.json`、`audit.json`。逐笔包括买卖盘与数量、模型概率、净盈亏上下限、盈亏平衡点、期望盈亏、最差 5% 的平均损益，以及预设波动/中心/成本压力情景。最差尾部平均值正确处理“最大亏损具有一整段价格区间”导致的概率质量，不把最大亏损金额乘以概率当作最大风险。

`Q0_market_lognormal_approximation` 标签必须随指标保留；它来自市场报价，不是经过验证的实际胜率。所有候选保留 `NO_TRADE_RESEARCH_ONLY`。出现正净EV时先记录模型与中间价差异、执行价差、费用，不能直接生成订单。净最大亏损只是研究资金准备值，不是 IBKR 保证金报价。

28 个合成情景检查无成本时 EV 为零、加成本后为负；独立审计不导入新积分引擎，通过逐腿现金流和高斯数值积分核对历史的 EV、概率和尾部平均损益。36 项测试通过，251 个可计价候选独立核算通过。

此轮只使用本地缓存。历史损益按缓存 SPX 日收盘近似 SPXW PM 结算值，尚未逐日核验官方结算记录；未建模多腿同时成交、额外结算收费、账户收益率或盘中退出。完整研究背景见 [PDE 文档分析](pde-strategy-review.md)。

### PDE-E02：更长历史与现实概率候选

固定参数位于 `research/options/pde-e02.json`，日期范围 2025-09-16 至 2026-09-15，首次运行登记规则和独立复制的日收盘输入。只通过已订阅的 Theta 接口补齐每日 10:00 全链快照，两个并发请求，每次 RPC 设置 60 秒期限；逐日缓存可恢复，已有 E01 行情和冻结 v1 保持原样。

```bash
.cache/thetadata-venv/bin/python services/theta/pde_history.py --probe
.cache/thetadata-venv/bin/python services/theta/pde_history.py
npm run theta:calibrate -- run
.cache/thetadata-venv/bin/python services/theta/audit_calibration.py
.cache/thetadata-venv/bin/python services/theta/plot_calibration.py
```

`calibration.py` 使用有符号标准化误差 `z = (log(close/F) + w²/2)/w`。每次只取此前最多 120 个有效日、至少 60 天；`P_normal` 拟合样本均值和标准差，`P_kernel` 用固定规则带宽的高斯核保留历史偏斜。`P_kernel` 在看本轮结果前指定为主研究候选，没有剪裁极端误差或按收益优化参数。

这些模型是待检验的 P 候选，字段明确带有 `unvalidated` 标签。分布评分使用同日期的标准化 CRPS、68%/95% 区间覆盖和宽度、PIT，以及方向/尾部事件 Brier 分数。相对 Q0 的均值差给出按 5 日连续块重采样的近似区间，不视作极端风险或结构变化的完整不确定性估计。

经济检验保留 E01 七种结构及基于 Q0 的行权价，避免同时改概率与选仓范围。三个模型各自每天最多选一组，按额外每张 $2 滑点后的 EV/最大损失排序；最大损失不超过 $1,000、模型 EV 和最大利润为正，否则不交易。每张 $1.50 开仓费另计。该风险限额只是固定实验过滤条件；没有本金账户或月收益率目标。

输出目录为 `data/thetadata/pde-e02/`。`registered-plan.json`、`daily-input.json`、`download-status.json`、`results.json`、`audit.json` 保存规则、输入及逐笔证据，`report.md` 和 `comparison.png` 展示结果。独立审计从原始快照重建 v1，逐日核对训练日期和混合分布价格；图表不用于反向改规则。

未来验证协议已登记为从 2026-09-16 开始，固定规则记录 60 个未来有效评估日；此轮历史计算没有完成这项未来验证，也没有设置自动任务。已查看的 E01 期间在报告中单独标注，新增历史也仅是回溯扩展。

### PDE-E03：分布质量门槛与有限组合搜索

规则先登记到 `research/options/pde-e03.json`，保持区间 v1 不变。在原有同日 10:00 研究之上，增加 11:00/14:00、下一交易日到期、按买卖价区间拟合的市场 Q，以及使用过去 IV/RV 与偏斜状态加权的 P 候选。当前支持九类定义风险的组合，按固定网格搜索。

```bash
# 只读使用已有订阅。两路并发；按到期日合并相邻决策日的 as-of 快照，缓存可续传。
.cache/thetadata-venv/bin/python services/theta/pde_search_data.py --bulk
npm run theta:search -- run
.cache/thetadata-venv/bin/python services/theta/audit_search.py
.cache/thetadata-venv/bin/python services/theta/report_search.py
npm run theta:test
```

`data/thetadata/pde-e03/` 保存登记规则、原始报价、派生分布、全部候选、逐时点模型选择、拒绝原因、完整组合交易、统计不确定性、审计及报告。as-of 来源保留 `quote_timestamp`；`timestamp` 表示预先规定的观察时刻，程序核对原始报价不来自未来。

每个时间/到期日模型只用此前已完成到期的 60–120 个样本训练，再用此前 20–40 个成熟预测的 CRPS 选择 P。主方案要求 P 的过去分布评分优于 Q，之后才比较扣除价差、费用、滑点的期望收益。先有信号再附加历史结算现金流；每天首次合格才进场，最多一个持仓，允许空仓。候选在 Q 下已经出现正成本后期望时，不把拟合残差当作可交易预测优势。

最终成绩见 [E03 结论](pde-e03-conclusions.md)。这是已查看历史上的研究评估，不是独立前瞻验证或实盘收益；结算损益曲线不包含完整盘中浮动回撤。没有部署订单、定时任务或擅自扩展仓位。

### 单日通用限制

- 卖出看跌行权价取区间下边界向下的 5 点档；卖出看涨取上边界向上的 5 点档；保护翼取固定宽度。
- 每个组合分别计算卖 bid / 买 ask 和中间价假设。中间价不视作已成交。
- 挂单量不足、报价缺失、交叉盘口、非正信用或毛利润不够费用的场景跳过；不使用下一分钟补前一分钟。
- 每张每次成交 $1.50 为成本假设，另有 $0 / $0.65 / $1.50 / $2.50 敏感性。不是 IBKR 的实际费用报价。
- 到期损益按 SPX 收盘点位和内在价值计算；盘中估值按反向平仓报价并计入平仓费用。
- 分钟采样回撤不是连续时间最大回撤，四腿 NBBO 不证明组合可同时成交，快照也不保证原始报价新鲜。
- 预测发布时间未独立存证。复盘以“该预测在假设入场时已可获得”为条件，不证明无前视偏差。
- 单日结果不能估计长期胜率；多日 38 天探索样本同样不足以证明稳定月收益。

## 官方资料

- [Python SDK](https://docs.thetadata.us/Python-Library/Getting-Started.html)
- [历史期权报价](https://docs.thetadata.us/operations_python/option_history_quote.html)
- [套餐权限](https://docs.thetadata.us/Articles/Getting-Started/Subscriptions.html)
- [数据问题与午夜维护](https://docs.thetadata.us/Articles/Data-And-Requests/Data-Issues.html)
- [Balder 区间](https://balder-ai.com/spx)
