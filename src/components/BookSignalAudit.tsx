"use client";

import { useState } from "react";
import { Badge, Group, Table, Text, TextInput, UnstyledButton } from "@mantine/core";
import { formatEtFromUtc } from "@/lib/discord/cardTime";
import type { LookbackTf } from "@/lib/fund/lookbackLogic";
import type { SignalExecutionEvent, SignalExecutionReason, SignalTracking } from "@/lib/fund/signalTracking";
import type { SignalReconciliationReport } from "@/lib/fund/signalReconciliation";

const REASONS: Record<SignalExecutionReason, string> = {
  accepted: "条件通过",
  cash: "现金不足",
  pool: "不在当时股票池",
  rps: "账户 RPS 条件未满足",
  eligibility: "账户参与条件未满足",
  window: "不在执行窗口",
  allocation: "可分配资金不足",
  holding: "账户已有持仓",
  legacy: "旧账本持仓沿用原规则",
  stop: "止损退出",
  target: "止盈退出",
  rsWeak: "RPS 转弱离场",
  veto: "相对强度条件退出",
  rotate: "账户置换",
  missing_quote: "缺少报价",
  delayed_quote: "行情补齐时已错过执行时点，不追补",
};
const STATUSES: Record<SignalExecutionEvent["status"], { label: string; color: string }> = {
  pending: { label: "待执行", color: "yellow" },
  bought: { label: "模拟买入", color: "teal" },
  skipped: { label: "已跳过", color: "orange" },
  exited: { label: "模拟卖出", color: "red" },
  observed: { label: "策略退出信号", color: "gray" },
};
const RECONCILIATION_LABELS: Record<SignalReconciliationReport["rows"][number]["status"], { label: string; color: string }> = {
  matched: { label: "记录相符", color: "teal" },
  different: { label: "存在差异", color: "orange" },
  local_record_not_found: { label: "未找到本地记录", color: "yellow" },
  tv_record_not_found: { label: "未找到 TV 留档", color: "yellow" },
  unverifiable: { label: "无法核实", color: "gray" },
};
const price = (value?: number) => value == null || !Number.isFinite(value) ? "—" : `$${value.toFixed(2)}`;
const time = (value?: string) => value ? formatEtFromUtc(value) : "未留档";
const parameter = (value: number | string | boolean | null, field: string) => value == null
  ? field === "takeProfitR" ? "无固定止盈" : "未启用"
  : typeof value === "boolean" ? value ? "开启" : "关闭" : String(value);

export function BookSignalAudit({ tf, tracking, reconciliation, heldSymbols = [] }: {
  tf: LookbackTf;
  tracking?: SignalTracking;
  reconciliation?: SignalReconciliationReport;
  heldSymbols?: string[];
}) {
  const [query, setQuery] = useState("");
  const [allEvents, setAllEvents] = useState(false);
  const [allComparisons, setAllComparisons] = useState(false);
  const matches = (symbol: string) => symbol.toUpperCase().includes(query.trim().toUpperCase());
  const events = [...(tracking?.events ?? [])].reverse().filter((event) => matches(event.symbol));
  const comparisons = (reconciliation?.rows ?? []).filter((row) => row.tf === tf && matches(row.symbol));
  const shownEvents = allEvents ? events : events.slice(0, 12);
  const shownComparisons = allComparisons ? comparisons : comparisons.slice(0, 12);
  const states = Object.entries(tracking?.states ?? {});
  const activeStates = states.filter(([, signal]) => signal.state.sigType !== 0 || signal.state.pendingEntry !== 0);
  const selectedStates = query.trim() ? states.filter(([symbol]) => matches(symbol)) : [];

  return (
    <section className="mt-6 space-y-4 border-t border-white/10 pt-5" aria-label={`${tf.toUpperCase()} 策略信号与模拟执行`}>
      <Group justify="space-between" align="flex-end">
        <div>
          <Text fw={600} size="sm">策略信号与模拟执行 · {tf.toUpperCase()}</Text>
          <Text size="xs" c="dimmed" mt={4}>
            本地计算产生信号，账户再检查现金与风控；跳过买点不会在有现金后自动补买。
          </Text>
        </div>
        <TextInput size="xs" label="按股票筛选" placeholder="输入股票代码" value={query}
          onChange={(event) => { setQuery(event.currentTarget.value); setAllEvents(false); setAllComparisons(false); }} />
      </Group>

      {tracking ? (
        <Text size="xs" c="dimmed">
          独立信号追踪基准 K 线：{time(tracking.activatedAt)} · 信号状态截至 {time(tracking.asOf)}。
          从该账本截止点继续跟踪，历史成交与净值保留原记录；2H 仍保留 RPS &lt; 10 账户风控。
        </Text>
      ) : (
        <Text size="sm" c="dimmed">
          此版本尚无独立信号状态留档。历史模拟成交不等于策略信号记录，不能据此判断 TV 是否同步。
        </Text>
      )}

      {tracking ? <div>
        <Text size="xs" c="dimmed">
          当前活动策略轮次 {activeStates.length} 个，其中 {activeStates.filter(([symbol]) => !tracking.accounts[symbol]).length} 个没有账户持仓或待执行单。
          {!query.trim() ? "按股票筛选可查看当前轮次与账户关联。" : ""}
        </Text>
        {selectedStates.length ? <div className="mt-3 grid gap-3 md:grid-cols-2">
          {selectedStates.slice(0, 8).map(([symbol, signal]) => {
            const account = tracking.accounts[symbol];
            const active = signal.state.sigType !== 0 || signal.state.pendingEntry !== 0;
            const buy = tracking.events.find((event) => event.type === "buy" && event.signalId === signal.signalId);
            const restoredCycle = active && signal.signalDate != null && !buy;
            const held = heldSymbols.includes(symbol);
            return <div key={symbol} className="rounded border border-white/10 p-3">
              <Group justify="space-between" gap="xs"><Text size="sm" fw={600} ff="monospace">{symbol} · {tf.toUpperCase()}</Text>
                <Badge size="xs" color={active ? "teal" : "gray"} variant="light">
                  {signal.state.pendingExit ? "已有策略退出信号" : signal.state.pendingEntry ? "策略买点待下一根" : active ? "技术周期延续" : "无活动策略轮次"}
                </Badge>
              </Group>
              <Text size="xs" c="dimmed" mt="xs">本轮买点 K 线：{signal.signalDate ? time(signal.signalDate) : "当前无活动买点"}</Text>
              <Text size="xs" c="dimmed" mt={4}>该股票状态截至：{time(signal.lastProcessedDate)}</Text>
              <Text size="xs" mt={4}>账户：{held
                ? account?.legacy ? "旧账本持仓，沿用原退出规则" : account?.signalId === signal.signalId ? "模拟持仓关联当前轮次" : "模拟持仓关联其他轮次"
                : account ? account.legacy ? "迁移前待执行单" : "已有待执行单" : "未持仓，暂无待执行单"}</Text>
              {restoredCycle && !account ? <Text size="xs" c="orange.4" mt={6}>
                已从历史行情恢复该策略轮次，账户未持有；同一轮不追补，等待后续新的有效买点再评估。
              </Text> : buy?.status === "skipped" ? <Text size="xs" c="orange.4" mt={6}>
                本轮买点已跳过：{REASONS[buy.reason]}。条件恢复后不会自动补买同一轮。
              </Text> : null}
            </div>;
          })}
        </div> : query.trim() ? <Text size="xs" c="dimmed" mt="xs">该股票尚无独立策略状态留档，无法判断当前轮次。</Text> : null}
        {selectedStates.length > 8 ? <Text size="xs" c="dimmed" mt="xs">仅展示前 8 项，请输入完整股票代码缩小范围。</Text> : null}
      </div> : null}

      <div>
        <Text size="xs" fw={600} c="dimmed" mb="xs">本地信号与执行留档 · {events.length} 条</Text>
        {shownEvents.length ? (
          <div className="table-scroll"><Table striped highlightOnHover fz="xs">
            <Table.Thead><Table.Tr>
              <Table.Th>股票 / 周期</Table.Th><Table.Th>记录类型</Table.Th><Table.Th>信号 K 线 / 价格</Table.Th>
              <Table.Th>账户执行</Table.Th><Table.Th>原因</Table.Th><Table.Th>模拟成交时间 / 价格</Table.Th>
            </Table.Tr></Table.Thead>
            <Table.Tbody>{shownEvents.map((event) => <ExecutionRow key={event.id} event={event} tf={tf} />)}</Table.Tbody>
          </Table></div>
        ) : <Text size="sm" c="dimmed">{query ? "没有找到该股票的执行留档。" : tracking
          ? "切换后尚无执行记录；不会补造历史信号或成交。" : "该版本未留存独立策略信号与执行原因。"}</Text>}
        {events.length > 12 && <UnstyledButton mt="xs" onClick={() => setAllEvents((value) => !value)}>
          <Text size="xs" c="dimmed">{allEvents ? "收起" : `展开其余 ${events.length - 12} 条留档`}</Text>
        </UnstyledButton>}
        <Text size="xs" c="dimmed" mt="sm">
          信号 K 线显示起点时间，收盘时间为按常规交易时段估算；两者均不是通知送达时间。
          策略周期结束不代表账户一定卖出；模拟成交按账本记录展示，通知渠道失败不决定是否记账。
        </Text>
      </div>

      <div className="border-t border-white/10 pt-4">
        <Text size="xs" fw={600} c="dimmed" mb="xs">TV 留档对账 · {comparisons.length} 条</Text>
        {reconciliation ? <>
          <Text size="xs" c="dimmed" mb="xs">
            生成于 {time(reconciliation.generatedAt)} · 对账截至 {time(reconciliation.asOf)}。
            {reconciliation.note}
          </Text>
          <Text size="xs" c="dimmed" mb="sm">
            留档窗口 {time(reconciliation.coverage.from)} → {time(reconciliation.coverage.through)}；
            本报告合计 TV {reconciliation.coverage.tvRecords} 条、本地信号 {reconciliation.coverage.localEvents} 条。
            {reconciliation.coverage.truncated ? "当前仅展示部分留档。" : ""}
            这是已保存记录的核对，不是实时、全量 TV 同步证明。
          </Text>
          {shownComparisons.length ? <div className="table-scroll"><Table striped highlightOnHover fz="xs">
            <Table.Thead><Table.Tr>
              <Table.Th>股票 / 周期 / 方向</Table.Th><Table.Th>对账结论</Table.Th><Table.Th>本地记录</Table.Th>
              <Table.Th>TV 留档</Table.Th><Table.Th>差异与依据</Table.Th>
            </Table.Tr></Table.Thead>
            <Table.Tbody>{shownComparisons.map((row) => {
              const status = RECONCILIATION_LABELS[row.status];
              return <Table.Tr key={row.id}>
                <Table.Td><Text size="xs" fw={600} ff="monospace">{row.symbol}</Text>{row.tf.toUpperCase()} · {row.event === "buy" ? "买" : "卖"}</Table.Td>
                <Table.Td><Badge size="xs" color={status.color} variant="light">{status.label}</Badge></Table.Td>
                <Table.Td>
                  <Text size="xs">{row.evidence === "account_fill" ? "历史模拟成交" : "本地信号"}</Text>
                  <Text size="xs" c="dimmed">{time(row.evidence === "account_fill" ? row.localFillTime : row.localSignalTime)}</Text>
                  <Text size="xs" ff="monospace">{price(row.localPrice)}</Text>
                  {row.localFillTime && row.evidence !== "account_fill" && <Text size="xs" c="dimmed">模拟成交 {time(row.localFillTime)}</Text>}
                </Table.Td>
                <Table.Td><Text size="xs" c="dimmed">{time(row.tvSignalTime)}</Text>
                  <Text size="xs" ff="monospace">{price(row.tvPrice)}</Text>
                  {row.tvEntryTime && <Text size="xs" c="dimmed">TV 入场 {time(row.tvEntryTime)}</Text>}
                </Table.Td>
                <Table.Td miw={230} maw={420}>
                  <Text size="xs">{row.summary}</Text>
                  {row.differences.map((difference, index) => <Text key={index} size="xs" c="dimmed" mt={4}>{difference}</Text>)}
                  {row.parameterDifferences.map((difference) => <Text key={difference.field} size="xs" c="dimmed" mt={4}>
                    {difference.label}：本地 {parameter(difference.local, difference.field)} / TV {parameter(difference.tv, difference.field)}
                  </Text>)}
                  {row.evidence === "account_fill" && <Text size="xs" c="dimmed" mt={4}>仅有账户成交证据，不能还原当时完整策略状态。</Text>}
                </Table.Td>
              </Table.Tr>;
            })}</Table.Tbody>
          </Table></div> : <Text size="sm" c="dimmed">{query ? "没有找到该股票的对账记录。" : "当前周期没有可展示的对账记录。"}</Text>}
          {comparisons.length > 12 && <UnstyledButton mt="xs" onClick={() => setAllComparisons((value) => !value)}>
            <Text size="xs" c="dimmed">{allComparisons ? "收起" : `展开其余 ${comparisons.length - 12} 条对账`}</Text>
          </UnstyledButton>}
        </> : <Text size="sm" c="dimmed">尚无 TV 对账报告。没有对应留档，无法判断是计算差异、记录不完整还是通知问题。</Text>}
      </div>
    </section>
  );
}

function ExecutionRow({ event, tf }: { event: SignalExecutionEvent; tf: LookbackTf }) {
  const status = STATUSES[event.status];
  return <Table.Tr>
    <Table.Td><Text size="xs" fw={600} ff="monospace">{event.symbol}</Text>{tf.toUpperCase()}</Table.Td>
    <Table.Td>{event.type === "buy" ? "本地买点" : event.type === "sell" ? "本地卖点" : "账户退出"}</Table.Td>
    <Table.Td>
      <Text size="xs">{time(event.signalDate)}</Text>
      <Text size="xs" c="dimmed">估算收盘 {time(event.signalTime)}</Text>
      <Text size="xs" ff="monospace">{price(event.signalPrice)}</Text>
      {event.type !== "buy" && event.entrySignalDate && <Text size="xs" c="dimmed">本轮买点 K 线 {time(event.entrySignalDate)}</Text>}
      {event.signalId.startsWith("legacy:") && <Text size="xs" c="orange.4">旧账本仓位 · 原退出规则</Text>}
    </Table.Td>
    <Table.Td><Badge size="xs" color={status.color} variant="light">{status.label}</Badge></Table.Td>
    <Table.Td>{REASONS[event.reason]}{event.rps != null ? <Text size="xs" c="dimmed">RPS {event.rps.toFixed(1)}</Text> : null}</Table.Td>
    <Table.Td>{event.fillDate ? <>
      <Text size="xs">{time(event.fillDate)}</Text><Text size="xs" ff="monospace">{price(event.fillPrice)}</Text>
    </> : <Text size="xs" c="dimmed">未记入模拟成交</Text>}</Table.Td>
  </Table.Tr>;
}
