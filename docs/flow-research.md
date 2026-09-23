# 异常期权流研究

入口 `/flow`，替代原市场雷达页面。`/mpr` 永久跳转到新入口；旧雷达展示组件删除。共享 MPR 计算仍被既有风控 / 回测使用，不随页面删除而改变交易行为。

## 数据口径

- 数据为 FL0WG0D 的 Discord 转发报道样本，不是完整成交带。按美东转发消息时间归属交易日，实际交易时间未知。
- 只纳入常规时段的原始 flow 报道；剔除 noteworthy、OI confirmed、recap、暗池及非交易日。SPY 实际日线与已有交易日历定义有效交易日。
- 同一 tweet ID 跨频道只计一次；不同到期日、不同原文不按近似金额合并。无法识别的文字复述仍可能重复，不把记录数描述成交易所成交笔数。
- 明确的 buyer/seller 标签优先；单腿原文明示买卖方才使用全文标签。方向不明保持 unknown，多腿共用金额无法分配时不计入权利金。
- 买 Call / 卖 Put 为偏多结构，买 Put / 卖 Call 为偏空结构。没有推断开仓、平仓、组合对冲或真实意图。
- 主主题互斥，标的集中度按已知权利金计算。未分类主题、缺金额、缺行情可见。
- RPS：复用 SP500 外生标尺和 alphaScore。严格对齐日期；缺少该日日线 / 标尺时不沿用旧值。日终排名与前日排名分开，ETF / 指数不赋个股 RPS。
- 历史补建标记 reconstructed；历史成分、价格修订和当时数据发布时间并未全部冻结，不能声称严格事前回测。
- 强势阈值 80；改善为 5 个交易日 RPS 变化 > 0。缺少 RPS 或 5D 变化时为待确认。
- 持续出现：近 5 个交易日 ≥ 3 个日期有记录；再次出现：近 20 日 ≥ 2 日；其余为首次观察。连续交易日数独立计算。来源无消息不等于采集正常且零成交；目前没有完整性认证。
- OI、Volume/OI、执行类型等尚未核验，不能声称完成全市场多因子异常检测。

## 后续观察

每个标的每天一个样本，使用原报告的分类。参考价为报道后下一交易日开盘价，T+1/5/10 为对应交易日收盘收益。日期必须精确匹配，不跳过缺失交易日；页面日期之后的行情不参与计算。

完整 10 日窗口才给 MFE / MAE；T+5 超额为同一开盘至收盘窗口股票收益减 SPY 收益。分组展示只含该窗口成熟且有行情的样本。它是股票价格观察，不是期权收益，也没有完成同板块 / 相近 RPS 的匹配对照。

## 更新与落盘

既有盘中 worker 继续采集。收盘链：

1. `market:refresh` 为最近 60 个自然日异常流标的补日线；这些股票不加入实际交易池，也不补交易用盘中行情。
2. `rps:snapshot` 为有足够日线的研究标的计算当日 RPS。
3. `flow:research -- --daily` 独立生成研究快照；不依赖 Gamma 推送、不发送新通知、不增加 cron 频率。

归档在 `MARKET_DATA_DIR/snapshots/flow-research/`，无根目录时在 `data/snapshots/flow-research/`。`index.json` 提供日期；每日日报包含不可变事实报告和截至该日的后续观察。普通重跑保留原报告，显式 `--rebuild` 才备份后重建并标记历史重建。

原始数据读取：生产为 `/desk/option-flow.json`；同机任务设置 `OPTION_FLOW_PATH=/var/lib/alpha-agent/desk/option-flow.json`。配置远程时，网络失败不偷偷回退仓库旧数据。

未初始化归档时，页面可只读地从原始数据重建，显示“历史重建”；生产建议先初始化快照以免首次访问批量读取行情。正常归档页面只读索引和当日报告。

## 首次部署 / 本地验证

```sh
# 数据服务器：代码同步后、原始采集和日线就绪后执行
MARKET_DATA_BASE_URL= OPTION_FLOW_PATH=/var/lib/alpha-agent/desk/option-flow.json \
  MARKET_DATA_DIR=/var/lib/alpha-agent/market npm run flow:research

# 本地从配置的数据服务器同步原始记录、RPS 和 SPY；用现有 Alpaca 凭据补股票日线
npm run flow:refresh -- --seed-sources
MARKET_DATA_BASE_URL= npm run flow:research -- --rebuild
```

`--seed-sources` 只写本地所配置的文件，不回传数据服务器。上线时还需安装新版 `alpha-daily-quant.sh`；任务时间保持既有设置。页面、采集 worker 若分开发布，旧 worker 中的打包日结逻辑需要重新 bundle 后部署才能应用方向 / 去重修正。

第一版全部为确定性规则、固定映射和模板，无 AI 调用。不接入五因子买点评分，也不产生新买卖指令。
