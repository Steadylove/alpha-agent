# DeepSeek 独立复盘分析

每日复盘新增第 08 模块 **AI Analyst Note**。原有七个模块、市场标签、信号评分、2H/4H 策略、账户和推送均保持原有逻辑。页面仅读取归档结果；打开或刷新页面不会请求模型。

## 生成链路

1. VPS 原日更任务生成复盘并完成宏观补采与原有推送。
2. 独立运行 `npm run review:analysis`，通过现有交易日历确认应分析的美东交易日。当天文件缺失时失败，不使用上一个交易日冒充。
3. 代码将已归档复盘整理成有日期、单位、来源与局限的事实包。历史信号按所选日期及原复盘生成时间截断；核心策略规则、密钥和完整原始信号不发送给模型。
4. DeepSeek 输出一段跨模块中文总览、最多两项重要变化、最多三项后续观察，以及必要的数据边界。第一版只保留这些重点，避免机械填写栏目；没有充分证据时相应部分为空。
5. 校验 JSON、长度、引用和日期后原子保存到 `snapshots/daily-review/analysis/YYYY-MM-DD.json`。重新生成时保存上一份成功版本到 `analysis/history/`。

模型只解释事实，不重新定义市场状态，不发出交易指令，不把同源指标当作独立确认。期权墙位与 GEX 为模型估算；账户为模型账本；信号后续价格变化不是策略成交收益。缺项、过期和未成熟样本保留相应标记。

## 配置

在已有 VPS 日更环境文件 `/var/lib/alpha-agent/daily-quant.env` 中配置：

```sh
DEEPSEEK_REVIEW_API_KEY=<已有 DeepSeek 服务密钥>
DEEPSEEK_REVIEW_MODEL=deepseek-v4-pro
```

优先读取专用的 `DEEPSEEK_REVIEW_API_KEY`，未配置时兼容 `DEEPSEEK_API_KEY`。服务器建议只新增专用变量，避免意外启用其他旧模块的 AI 调用。密钥仅供服务器日更进程使用，不需要配置到浏览器，不写入公开快照。模型可以用同一 API 支持的模型名称覆盖。手动 GitHub 日更路径读取`DEEPSEEK_API_KEY` repository secret 和 `DEEPSEEK_REVIEW_MODEL` variable；缺配置时该分析步骤失败但不阻断原始复盘。

先检查数据，再按需要生成：

```sh
env -u VERCEL MARKET_DATA_BASE_URL= npm run review:analysis -- --dry-run
env -u VERCEL MARKET_DATA_BASE_URL= npm run review:analysis
```

在上述命令的环境中，`MARKET_DATA_DIR` 必须指向日更 worker 的真实行情根目录。`--dry-run` 校验证据但不调用模型。缺少密钥、超时、无效 JSON 或不存在的引用都不会覆盖已成功保存的结果。

历史补算与主动重算：

```sh
npm run review:analysis -- --date=2026-09-24
npm run review:analysis -- --date=2026-09-24 --force
```

仍要求本地行情模式。历史结果保存实际生成时间，不冒充当日预先发表的观点。同一事实包、提示词版本与模型再次运行会直接复用；`--force` 才强制重新请求。

## 页面与校验边界

- 每个结论可展开所引用的事实，并跳回原始模块。
- 市场状态、宏观标签和数据完整性分别显示，`Partial` 不替代 `Neutral`、`Mixed` 或 `Unknown`。
- 分析缺失或损坏不影响前七个模块，也不会回退到其他日期或构建机上的旧结果。
- 来源后来补采或更正时显示旧版提示；下次运行分析会按新证据生成。仅新增未来日期信号不会使历史分析失效。
- 模型请求有时间与输出上限。只保存最终通过校验的内容与 token 数，不保存模型推理过程或服务端提示词。
- JSON 和引用校验只能确认结构与引用存在，不能证明模型文字推论完全正确。原始模块是事实依据。
- 本模块没有 Discord/Telegram 推送、交易执行或自动修改原有模块的能力。

## 验证

相关测试：`reviewAnalysisEvidence`、`reviewAnalysisModel`、`reviewAnalysisService`、`reviewAnalysisUi` 与 `dailyQuantCron`。覆盖数据缺失、过期、历史截断、错误引用、成功结果保护、数据变动、远程读取失败和任务隔离。调度测试全部使用桩命令，不能用运行真实整条日更任务代替测试。

提示词位于 `src/lib/review/analysis/prompt.ts`；更新行为时递增 `PROMPT_VERSION`。临时分析锁位于行情根目录 `.review-analysis.lock`，进程正常结束会清除。遇到锁异常先核对对应进程，避免并发重复付费。
