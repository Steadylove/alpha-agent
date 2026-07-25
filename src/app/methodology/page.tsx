"use client";

import { Card } from "@/components/Card";
import {
  Accordion,
  Alert,
  Badge,
  Group,
  List,
  Stack,
  Table,
  Text,
  Title,
} from "@mantine/core";
import { AlertTriangle, ArrowRight, ShieldAlert } from "lucide-react";

const PIPELINE = [
  { label: "Kill Switch", note: "6 条量化熔断", color: "red" },
  { label: "Stock Quality", note: "50 分", color: "teal" },
  { label: "Valuation", note: "20 分", color: "yellow" },
  { label: "Environment", note: "15 分", color: "blue" },
  { label: "Execution", note: "15 分", color: "grape" },
  { label: "Final Compass", note: "0-100", color: "cyan" },
];

export default function MethodologyPage() {
  return (
    <div className="space-y-6">
      <div>
        <Title order={2} c="gray.0" fw={600}>
          Methodology · v3 白皮书 6.1 计算逻辑
        </Title>
        <Text size="sm" c="dimmed" mt={4}>
          Final Compass Score = 股票质量 50 + 估值赔率 20 + 市场环境 15 + 执行买点 15，命中 Kill Switch → 直接 0
        </Text>
      </div>

      <Card title="v3 两阶段流水线">
        <Group gap="xs" wrap="wrap">
          {PIPELINE.map((step, i) => (
            <Group key={step.label} gap="xs">
              <Badge color={step.color} variant="light" size="lg" radius="md">
                {step.label} · {step.note}
              </Badge>
              {i < PIPELINE.length - 1 ? <ArrowRight className="h-4 w-4 text-zinc-500" /> : null}
            </Group>
          ))}
        </Group>
        <Text size="xs" c="dimmed" mt="sm">
          <b>阶段 1</b>：Kill Switch 是硬过滤器，任一条命中即整只股 Final = 0，不参与排名。
          <br />
          <b>阶段 2</b>：4 大分数并行计算，直接相加得 Final Compass Score（不再二层加权）。
        </Text>
      </Card>

      <Accordion variant="separated" radius="md" defaultValue="killswitch">
        {/* 模块零 · Kill Switch */}
        <Accordion.Item value="killswitch">
          <Accordion.Control>
            <Group>
              <Badge color="red">0</Badge>
              <ShieldAlert className="h-4 w-4 text-red-400" />
              <Text fw={600}>Kill Switch · 一票否决熔断器（6/8 已实现）</Text>
            </Group>
          </Accordion.Control>
          <Accordion.Panel>
            <Stack gap="sm">
              <Text size="sm" c="gray.3">
                v3 白皮书要求命中即 Score=0，不推荐、不排名。免费数据源可覆盖 6 条量化规则，另 2 条（并购传闻 / Guidance 下修）需 LLM，留给 Wave 3。
              </Text>
              <Table striped withTableBorder verticalSpacing="xs" fz="sm">
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>规则</Table.Th>
                    <Table.Th>数据源</Table.Th>
                    <Table.Th>阈值</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  <Table.Tr>
                    <Table.Td>反向拆股 12M</Table.Td>
                    <Table.Td>基本面数据 (S&P 500 极少见，暂放弃 API)</Table.Td>
                    <Table.Td>存在即熔断</Table.Td>
                  </Table.Tr>
                  <Table.Tr>
                    <Table.Td>市值 &lt; $1B</Table.Td>
                    <Table.Td>Universe 前置过滤 (S&P 500 恒满足)</Table.Td>
                    <Table.Td>&lt; 10 亿美元 → 熔断</Table.Td>
                  </Table.Tr>
                  <Table.Tr>
                    <Table.Td>20D 平均日成交额</Table.Td>
                    <Table.Td>K 线 (close × volume)</Table.Td>
                    <Table.Td>&lt; $30M → 熔断</Table.Td>
                  </Table.Tr>
                  <Table.Tr>
                    <Table.Td>12M 增发稀释</Table.Td>
                    <Table.Td>FMP income (weightedAverageShsOutDil YoY)</Table.Td>
                    <Table.Td>&gt; +15% → 熔断</Table.Td>
                  </Table.Tr>
                  <Table.Tr>
                    <Table.Td>Gross Margin 连降</Table.Td>
                    <Table.Td>FMP income (最近 6 季环比)</Table.Td>
                    <Table.Td>≥ 2 季连降 → 熔断</Table.Td>
                  </Table.Tr>
                  <Table.Tr>
                    <Table.Td>21D 内单日涨幅</Table.Td>
                    <Table.Td>K 线</Table.Td>
                    <Table.Td>&gt; +30% → 熔断（防事件脉冲）</Table.Td>
                  </Table.Tr>
                  <Table.Tr>
                    <Table.Td c="dimmed">并购传闻（无 SEC 披露）</Table.Td>
                    <Table.Td c="dimmed">SEC EDGAR × 新闻语义</Table.Td>
                    <Table.Td c="dimmed">Wave 3 push back</Table.Td>
                  </Table.Tr>
                  <Table.Tr>
                    <Table.Td c="dimmed">Guidance 连续下修</Table.Td>
                    <Table.Td c="dimmed">earnings-transcripts (付费)</Table.Td>
                    <Table.Td c="dimmed">Wave 3 push back</Table.Td>
                  </Table.Tr>
                </Table.Tbody>
              </Table>
              <Alert variant="light" color="grape" icon={<AlertTriangle size={14} />}>
                <Text size="sm" fw={600}>Wave 3 现实边界（push back）</Text>
                <Text size="xs" mt={4}>
                  • <b>Guidance 连续下修</b>：需要多期公司自己的 Guidance 历史，`earnings-transcripts` 是 FMP 付费 endpoint，`analyst-estimates` 只有分析师估计而非公司 Guidance —— <b>免费源无法严谨判断</b>。
                  <br />
                  • <b>M&A 传闻</b>：需要新闻 × SEC EDGAR 8-K 联动比对，LLM 很容易把已披露收购公告误判成传闻 —— <b>硬做会引入大量假阳性</b>。
                  <br />
                  两条规则要么升级付费源，要么接入 SEC EDGAR + 专门的语义比对流水线。当前不做，避免误伤真实优质股。
                </Text>
              </Alert>
            </Stack>
          </Accordion.Panel>
        </Accordion.Item>

        {/* 股票质量 · Momentum 15 */}
        <Accordion.Item value="momentum">
          <Accordion.Control>
            <Group>
              <Badge color="teal">1a</Badge>
              <Text fw={600}>Momentum Quality · 动量质量（15 分）</Text>
            </Group>
          </Accordion.Control>
          <Accordion.Panel>
            <Stack gap="sm">
              <Text size="sm" c="gray.3">
                v3 相对 v6.0 的关键修复：线性加速度替代二值阶跃，Event Ratio 过滤事件脉冲。
              </Text>
              <Table striped withTableBorder verticalSpacing="xs" fz="sm">
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>子项</Table.Th>
                    <Table.Th>公式</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  <Table.Tr>
                    <Table.Td>加权 RPS · 8 分</Table.Td>
                    <Table.Td>
                      <code>weightedRps = 0.5×rps63 + 0.3×rps21 + 0.2×rps252</code>
                      <br />
                      得分 = weightedRps / 100 × 8（线性，无 90 门槛）
                    </Table.Td>
                  </Table.Tr>
                  <Table.Tr>
                    <Table.Td>加速度 · 4 分</Table.Td>
                    <Table.Td>
                      <code>acceleration = rps21 − rps63</code>
                      <br />
                      得分 = clamp(acceleration / 20, 0, 1) × 4
                    </Table.Td>
                  </Table.Tr>
                  <Table.Tr>
                    <Table.Td>Event Ratio · 3 分</Table.Td>
                    <Table.Td>
                      <code>eventRatio = 21D 最大单日涨幅 / (ATR14 / close)</code>
                      <br />
                      &gt; 3 → 0 分（事件脉冲）· &gt; 2 → 1 分 · 否则 3 分
                    </Table.Td>
                  </Table.Tr>
                </Table.Tbody>
              </Table>
            </Stack>
          </Accordion.Panel>
        </Accordion.Item>

        {/* 股票质量 · Trend 10 */}
        <Accordion.Item value="trend">
          <Accordion.Control>
            <Group>
              <Badge color="teal">1b</Badge>
              <Text fw={600}>Trend Structure · 趋势结构（10 分）</Text>
            </Group>
          </Accordion.Control>
          <Accordion.Panel>
            <Table striped withTableBorder verticalSpacing="xs" fz="sm">
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>子项</Table.Th>
                  <Table.Th>公式</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                <Table.Tr>
                  <Table.Td>均线+新高 · 4 分</Table.Td>
                  <Table.Td>
                    Close &gt; MA20 &gt; MA50 &gt; MA200 → +2；距 52 周高 ≤ 15% → +2
                  </Table.Td>
                </Table.Tr>
                <Table.Tr>
                  <Table.Td>Up Day Ratio 63D · 3 分</Table.Td>
                  <Table.Td>63 天内收阳线比例 ≥ 60% → 3；≥ 50% → 2；≥ 40% → 1</Table.Td>
                </Table.Tr>
                <Table.Tr>
                  <Table.Td>Drawdown Recovery 3M · 3 分</Table.Td>
                  <Table.Td>3 月内最大回撤 |dd| ≤ 8% → 3；≤ 15% → 2；≤ 25% → 1</Table.Td>
                </Table.Tr>
              </Table.Tbody>
            </Table>
          </Accordion.Panel>
        </Accordion.Item>

        {/* 股票质量 · Fundamental 25 */}
        <Accordion.Item value="fundamental">
          <Accordion.Control>
            <Group>
              <Badge color="teal">1c</Badge>
              <Text fw={600}>Fundamental Quality · 基本面质量（25 分）</Text>
            </Group>
          </Accordion.Control>
          <Accordion.Panel>
            <Stack gap="sm">
              <Table striped withTableBorder verticalSpacing="xs" fz="sm">
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>子项</Table.Th>
                    <Table.Th>算法</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  <Table.Tr>
                    <Table.Td>Growth · 8 分</Table.Td>
                    <Table.Td>
                      Revenue YoY ≥ 30% → 8；≥ 20% → 6；≥ 10% → 4；≥ 5% → 2
                    </Table.Td>
                  </Table.Tr>
                  <Table.Tr>
                    <Table.Td>Profit · 7 分</Table.Td>
                    <Table.Td>
                      GM ≥ 50% → +4，≥ 35% → +3，≥ 20% → +2
                      <br />
                      ROIC ≥ 15% → +3，≥ 8% → +2，&gt; 0 → +1（合计封顶 7）
                    </Table.Td>
                  </Table.Tr>
                  <Table.Tr>
                    <Table.Td>Revisions · 5 分</Table.Td>
                    <Table.Td>
                      FMP grades 30D 净情绪 &gt; +20% → 5；&gt; +10% → 4；&gt; 0 → 2
                    </Table.Td>
                  </Table.Tr>
                  <Table.Tr>
                    <Table.Td>Moat · 5 分 <Badge color="grape" size="xs" ml={4}>Wave 3 · LLM</Badge></Table.Td>
                    <Table.Td>
                      DeepSeek 从 5 个维度评分（1-5 整数）：
                      <br />
                      <b>1</b>. 品牌/定价权 · <b>2</b>. 网络效应 · <b>3</b>. 规模成本 · <b>4</b>. 转换成本/生态锁定 · <b>5</b>. 无形资产（专利/牌照）
                      <br />
                      5 = NVDA/MSFT/MA 级 · 3 = 中等可替代 · 1 = 无护城河同质化
                      <br />
                      <Text component="span" size="xs" c="dimmed">
                        每天只对 Top 30 打 1 次 LLM 调用；失败或未覆盖 → 兜底 3 分（中性）。
                      </Text>
                    </Table.Td>
                  </Table.Tr>
                </Table.Tbody>
              </Table>
              <Alert variant="light" color="red" icon={<AlertTriangle size={14} />}>
                ⛔ 一票否决：EPS Revision &lt; -10% → 该维直接归 0
              </Alert>
              <Alert variant="light" color="yellow" icon={<AlertTriangle size={14} />}>
                FMP 免费额度分层：全 100 只只拿 Growth + GM（最多 12 分 + Moat 兜底 3 = 15 分），Top 30 才补 ROIC + Revisions + LLM Moat（全 25 分）。
              </Alert>
            </Stack>
          </Accordion.Panel>
        </Accordion.Item>

        {/* 估值 · Valuation 20 */}
        <Accordion.Item value="valuation">
          <Accordion.Control>
            <Group>
              <Badge color="yellow">2</Badge>
              <Text fw={600}>Valuation · 估值赔率（20 分）· PWFV + 60D RRR</Text>
            </Group>
          </Accordion.Control>
          <Accordion.Panel>
            <Stack gap="sm">
              <Text size="sm" c="gray.3" fw={600}>
                🎯 6-12M PWFV · 概率加权公允价（10 分）
              </Text>
              <List size="sm" spacing={4} c="gray.3">
                <List.Item>
                  <b>Base</b> = FMP price-target-consensus（分析师 12M 目标价）
                </List.Item>
                <List.Item>
                  <b>Bear</b> = Base × 0.75 · <b>Bull</b> = Base × 1.25
                </List.Item>
                <List.Item>
                  <b>加权公允价</b> = 20% Bear + 55% Base + 25% Bull
                </List.Item>
                <List.Item>
                  <b>安全边际 (MoS)</b> = (加权公允价 − 当前价) / 当前价
                </List.Item>
                <List.Item>
                  MoS ≥ 20% → 10 分；≥ 10% → 7；≥ 5% → 5；≥ 0 → 3；≥ -10% → 1；否则 0
                </List.Item>
              </List>

              <Text size="sm" c="gray.3" fw={600} mt="xs">
                🎯 60D Trading Target · 波段目标价（10 分）
              </Text>
              <List size="sm" spacing={4} c="gray.3">
                <List.Item>
                  <b>Target</b> = min(60D 最高价阻力位, 当前价 + 1.5 × ATR14 × √60)
                </List.Item>
                <List.Item>
                  <b>Stop Loss</b> = 当前价 − 2 × ATR14
                </List.Item>
                <List.Item>
                  <b>RRR</b> = (Target − 当前价) / (当前价 − Stop Loss)
                </List.Item>
                <List.Item>
                  RRR ≥ 2 → 10 分；≥ 1.5 → 8；≥ 1 → 5；≥ 0.5 → 2；否则 0
                </List.Item>
              </List>

              <Alert variant="light" color="cyan">
                <Text size="sm">
                  <b>Dual-Target 双价格解耦</b>：PWFV 是「长期公允价」（值不值得持有），Trading Target 是「短期波段」（未来 60D 交易目标）。v3 白皮书特别强调不能混。
                </Text>
              </Alert>
              <Alert variant="light" color="yellow" icon={<AlertTriangle size={14} />}>
                无 analyst target 时（非 Top 30）走 fallback：Base = 当前价 × (1 + 20D 动量 × 3)，MoS 可能偏低。
              </Alert>
            </Stack>
          </Accordion.Panel>
        </Accordion.Item>

        {/* 环境 · Environment 15 */}
        <Accordion.Item value="environment">
          <Accordion.Control>
            <Group>
              <Badge color="blue">3</Badge>
              <Text fw={600}>Environment · 市场环境（15 分）· 全市场共享</Text>
            </Group>
          </Accordion.Control>
          <Accordion.Panel>
            <Stack gap="sm">
              <Text size="sm" c="gray.3">
                MSS 的 4 因子（原 25 分制）归一到 5 + 5 + 5，直接注入每一只股票的 Final。
                所有股票拿到相同的 Environment 分。
              </Text>
              <Table striped withTableBorder verticalSpacing="xs" fz="sm">
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>子项</Table.Th>
                    <Table.Th>数据源</Table.Th>
                    <Table.Th>算法</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  <Table.Tr>
                    <Table.Td>MSS · 5 分</Table.Td>
                    <Table.Td>SKEW + VIX 归一</Table.Td>
                    <Table.Td>尾部风险 + 风险偏好 各 25 分/2 平均，再 /5</Table.Td>
                  </Table.Tr>
                  <Table.Tr>
                    <Table.Td>Breadth · 5 分</Table.Td>
                    <Table.Td>S&P 500 K 线</Table.Td>
                    <Table.Td>50D 站上比例 &gt; 60% → 5；40-60% → 3；&lt; 40% → 0</Table.Td>
                  </Table.Tr>
                  <Table.Tr>
                    <Table.Td>Credit · 5 分</Table.Td>
                    <Table.Td>HYG - TLT 相对</Table.Td>
                    <Table.Td>21D 相对收益 &gt; -2% → 5；否则 0（利差走阔警报）</Table.Td>
                  </Table.Tr>
                </Table.Tbody>
              </Table>
            </Stack>
          </Accordion.Panel>
        </Accordion.Item>

        {/* 执行 · Execution 15 */}
        <Accordion.Item value="execution">
          <Accordion.Control>
            <Group>
              <Badge color="grape">4</Badge>
              <Text fw={600}>Execution · 执行买点（15 分）</Text>
            </Group>
          </Accordion.Control>
          <Accordion.Panel>
            <Stack gap="sm">
              <Text size="sm" c="gray.3">
                每只股都算，判断「现在能不能进场」。v3 简化：GBZ + Selling Pressure + 止损空间。
              </Text>
              <Table striped withTableBorder verticalSpacing="xs" fz="sm">
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>子项</Table.Th>
                    <Table.Th>算法</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  <Table.Tr>
                    <Table.Td>GBZ 位置 · 8 分</Table.Td>
                    <Table.Td>
                      GBZ = (SMA20 + SMA50 + TWAP20) / 3 × [0.988, 1.012]
                      <br />
                      当前价在 GBZ 内 → 8；距上沿 0-3% → 5；3-8% → 2；&gt; 8% → 0
                    </Table.Td>
                  </Table.Tr>
                  <Table.Tr>
                    <Table.Td>Selling Pressure · 4 分</Table.Td>
                    <Table.Td>
                      20D 下跌日成交量 / 总成交量 &lt; 35% → 4；35-50% → 2；&gt; 50% → 0
                    </Table.Td>
                  </Table.Tr>
                  <Table.Tr>
                    <Table.Td>止损比 · 3 分</Table.Td>
                    <Table.Td>
                      (当前价 - 2×ATR14) / 当前价 ≤ 8% → 3；≤ 15% → 2；&gt; 15% → 0
                    </Table.Td>
                  </Table.Tr>
                </Table.Tbody>
              </Table>
              <Alert variant="light" color="cyan">
                <Text size="sm">
                  Execution 15 分不是「Top 1 独享」，而是每只股都算 —— 让排在中段但形态到位的股能被识别。
                </Text>
              </Alert>
            </Stack>
          </Accordion.Panel>
        </Accordion.Item>

        {/* Portfolio Monitor */}
        <Accordion.Item value="monitor">
          <Accordion.Control>
            <Group>
              <Badge color="pink">5</Badge>
              <Text fw={600}>Portfolio Monitor · 状态追踪</Text>
            </Group>
          </Accordion.Control>
          <Accordion.Panel>
            <Text size="sm" c="gray.3">
              对当日 Top 10 与昨日状态对比，标记 <b>FOCUS / WATCH / NEW / DOWNGRADED</b>。
              状态由 Final Compass Score 排名决定：rank ≤ 2 → FOCUS；rank ≤ 5 或 Final ≥ 70 → WATCH；否则 → DOWNGRADED。
              昨日未出现的股 → NEW。<b>Kill Switch 命中的股永远是 DOWNGRADED。</b>
            </Text>
          </Accordion.Panel>
        </Accordion.Item>

        {/* AI Insights */}
        <Accordion.Item value="llm">
          <Accordion.Control>
            <Group>
              <Badge color="grape">Extra</Badge>
              <Text fw={600}>AI Insights · LLM 层（Wave 3 已参与打分）</Text>
            </Group>
          </Accordion.Control>
          <Accordion.Panel>
            <Stack gap="sm">
              <Text size="sm" c="gray.3">
                模型：<code>deepseek-v4-flash</code>，temperature 0.3，强制 JSON。
              </Text>
              <Text size="sm" c="gray.3" fw={600} mt="xs">
                🎯 打分参与（Wave 3）
              </Text>
              <List size="sm" spacing={4} c="gray.3">
                <List.Item>
                  <b>Moat 1-5 分</b> · 每日 Top 30 各 1 次调用（30 req/day），失败兜底 3 分
                </List.Item>
              </List>
              <Text size="sm" c="gray.3" fw={600} mt="xs">
                📝 报告文案（不参与打分）
              </Text>
              <List size="sm" spacing={4} c="gray.3">
                <List.Item><b>marketNarrative</b> · 30-60 字宏观定性</List.Item>
                <List.Item><b>themeChain</b> · 今日产业链传导（2-5 环）</List.Item>
                <List.Item><b>beneficiarySectors</b> · 3-5 个受益板块</List.Item>
                <List.Item><b>sectorHeadlines</b> · Top 3 板块主线定语</List.Item>
                <List.Item><b>featuredQuality</b> · 首推股主题定位一句话</List.Item>
              </List>
              <Alert variant="light" color="grape">
                <Text size="sm">
                  DeepSeek 每日总用量：Moat 30 次 + 报告洞察 1 次 = <b>31 req/day</b>，成本约 $0.005/day（v4-flash 定价）。
                </Text>
              </Alert>
            </Stack>
          </Accordion.Panel>
        </Accordion.Item>

        {/* 数据源 */}
        <Accordion.Item value="data">
          <Accordion.Control>
            <Group>
              <Badge color="gray">DS</Badge>
              <Text fw={600}>数据源分层 · FMP 免费 250/天约束</Text>
            </Group>
          </Accordion.Control>
          <Accordion.Panel>
            <Stack gap="sm">
              <Table striped withTableBorder verticalSpacing="xs" fz="sm">
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>数据</Table.Th>
                    <Table.Th>来源</Table.Th>
                    <Table.Th>频率</Table.Th>
                    <Table.Th>降级策略</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  <Table.Tr>
                    <Table.Td>日 K 线（S&P 500 全池）</Table.Td>
                    <Table.Td>Stooq → Yahoo</Table.Td>
                    <Table.Td>每日</Table.Td>
                    <Table.Td>失败跳过；DB 只留 Top 100</Table.Td>
                  </Table.Tr>
                  <Table.Tr>
                    <Table.Td>S&P 500 成分股</Table.Td>
                    <Table.Td>GitHub CSV</Table.Td>
                    <Table.Td>24h 缓存</Table.Td>
                    <Table.Td>失败 → 内置 15 只回退池</Table.Td>
                  </Table.Tr>
                  <Table.Tr>
                    <Table.Td>SKEW / VIX</Table.Td>
                    <Table.Td>CBOE CDN CSV</Table.Td>
                    <Table.Td>每日</Table.Td>
                    <Table.Td>缺失 → MSS 因子 N/A，其余等比放大</Table.Td>
                  </Table.Tr>
                  <Table.Tr>
                    <Table.Td>基本面 Layer 1</Table.Td>
                    <Table.Td>FMP <code>/stable/income-statement</code></Table.Td>
                    <Table.Td>Top 100 × 1 次 = 100 req</Table.Td>
                    <Table.Td>拿 Growth / GM / GM 环降 / 稀释</Table.Td>
                  </Table.Tr>
                  <Table.Tr>
                    <Table.Td>基本面 Layer 2</Table.Td>
                    <Table.Td>FMP <code>/stable/ratios-ttm + grades + price-target-consensus</code></Table.Td>
                    <Table.Td>Top 30 × 3 次 = 90 req</Table.Td>
                    <Table.Td>拿 ROIC / FCF Margin / 分析师修正 / 12M 目标价</Table.Td>
                  </Table.Tr>
                  <Table.Tr>
                    <Table.Td>新闻</Table.Td>
                    <Table.Td>Finnhub</Table.Td>
                    <Table.Td>每日 Top 20 条</Table.Td>
                    <Table.Td>失败 → 报告『暂无新闻』</Table.Td>
                  </Table.Tr>
                  <Table.Tr>
                    <Table.Td>AI 洞察</Table.Td>
                    <Table.Td>DeepSeek</Table.Td>
                    <Table.Td>每次生成/推送</Table.Td>
                    <Table.Td>失败 → insights=null，报告去掉 AI 段</Table.Td>
                  </Table.Tr>
                </Table.Tbody>
              </Table>
              <Alert variant="light" color="teal">
                <Text size="sm">
                  <b>FMP 总用量</b>：100 + 90 = 190 req/day，留 60 缓冲。若升级到 Starter ($14/mo, 300 req/min) 可去掉分层，全量拿满 25 分基本面。
                </Text>
              </Alert>
            </Stack>
          </Accordion.Panel>
        </Accordion.Item>
      </Accordion>

      <Card title="Final Compass Score · 总公式">
        <Stack gap={4}>
          <Text size="sm" c="gray.2" ff="monospace">
            finalCompassScore = qualityScore + valuationScore + environmentScore + executionScore
          </Text>
          <Text size="sm" c="gray.2" ff="monospace">
            {`qualityScore = momentumScore(15) + trendScore(10) + fundamentalScore(25) = 0-50`}
          </Text>
          <Text size="xs" c="dimmed" mt="xs">
            无二层权重、无归一化。直接四大子分数相加 = 0-100。
            <br />
            v3 相对 v6.0 的关键区别：Sector 15 分被拿掉（不再作个股加分项，只作 Insight），
            Accumulation 15 分拆到 Execution 里。
          </Text>
        </Stack>
      </Card>

      <Text size="xs" c="dimmed" ta="center">
        源码：<code>src/lib/scoring/</code>（stock.ts / stockQuality.ts / valuation.ts / execution.ts / environment.ts / killSwitch.ts / indicators.ts）
        <br />
        文档：<code>Market Compass 6.1 量化白皮书.docx</code>
      </Text>
    </div>
  );
}
