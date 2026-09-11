import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { deliverTvAlert, POST as alert } from "@/app/api/tv/alert/route";
import { POST as book } from "@/app/api/tv/render-book/route";
import { POST as gex } from "@/app/api/tv/render-gex/route";
import { POST as market } from "@/app/api/tv/render-market-state/route";

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  lookup: vi.fn(),
  render: vi.fn(),
  png: Buffer.from("rendered-image"),
  after: vi.fn((task: () => unknown) => task),
}));
vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return { ...actual, after: (task: () => unknown) => mocks.after(task) };
});
vi.mock('@/lib/notifications/postSignalImage', () => ({ postSignalImage: mocks.push }));
vi.mock('@/lib/backtest/rpsSnapshot', () => ({ ensureRpsSnapshot: vi.fn(), lookupAlertRps: mocks.lookup, resolveAlertTimeframe: () => '4h' }));
vi.mock('@/lib/discord/signalCardOg', () => ({ renderSignalOgPng: mocks.render }));
vi.mock('@/lib/discord/bookCardOg', () => ({ renderCashBookOgPng: async () => mocks.png }));
vi.mock('@/lib/discord/gexCardOg', () => ({ renderGexOgPng: async () => mocks.png }));
vi.mock('@/lib/discord/gexBriefCardOg', () => ({ isGexBriefView: () => true, renderGexBriefOgPng: async () => mocks.png }));
vi.mock('@/lib/discord/marketStateCardOg', () => ({ renderMarketStateOgPng: async () => mocks.png }));
const request = (value: unknown) => new Request('https://app.test/api', { method: 'POST', body: JSON.stringify(value) });
const hook = "https://discord.example/hook";
beforeEach(() => { vi.resetAllMocks(); mocks.render.mockResolvedValue(mocks.png); vi.stubEnv('DISCORD_SIGNAL_WEBHOOK_URL', hook); });
afterEach(() => vi.unstubAllEnvs());

it("合法告警先回 accepted，出图推送等 after 再跑", async () => {
  const payload = { event: "sell", symbol: "CF", tf: "240", price: 100, kind: 1, barTime: 1 };
  const res = await alert(request(payload));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true, accepted: true });
  expect(mocks.push).not.toHaveBeenCalled();
  const queued = mocks.after.mock.calls[0]?.[0] as () => Promise<unknown>;
  await queued();
  expect(mocks.push).toHaveBeenCalledTimes(1);
});

it('买点仍需通过原 RPS 门槛，卖点照常走双平台入口', async () => {
  const payload = { event: 'buy', symbol: 'CF', tf: '240', price: 100, kind: 1, barTime: 123456 };
  mocks.lookup.mockReturnValue({ rps: 5 });
  expect(await deliverTvAlert(payload, hook)).toMatchObject({ forwarded: false });
  expect(mocks.push).not.toHaveBeenCalled();
  mocks.lookup.mockReturnValue({ rps: 90 });
  expect(await deliverTvAlert(payload, hook)).toMatchObject({ forwarded: true });
  expect(mocks.push.mock.calls[0][1].bytes).toBe(mocks.png);
  await deliverTvAlert(payload, hook);
  expect(mocks.push.mock.calls[1][1].eventKey).toBe(mocks.push.mock.calls[0][1].eventKey);
  await deliverTvAlert({ ...payload, event: 'sell' }, hook);
  expect(mocks.push).toHaveBeenCalledTimes(3);
});
it('旧版没有 K 线时间时不误吞另一笔同价位交易', async () => {
  const payload = { event: 'sell', symbol: 'CF', tf: '240', price: 100, kind: 1 };
  await deliverTvAlert(payload, hook); await deliverTvAlert(payload, hook);
  expect(mocks.push.mock.calls[0][1].eventKey).not.toBe(mocks.push.mock.calls[1][1].eventKey);
});
it('卖点快照进入渲染器并复用同一张图发送双平台，坏快照仍发原卡片', async () => {
  const payload = { event: 'sell', symbol: 'CF', tf: '240', price: 110, entry: 100, kind: 1, entryTime: 1000, barTime: 3000,
    chart: { version: 1, stride: 1, bars: [[1000, 2000, 100, 105, 99, 104, 98, 97, 92, 90], [2000, 3000, 104, 112, 100, 110, 99, 98, 93, 91]] } };
  expect((await deliverTvAlert(payload, hook)).forwarded).toBe(true);
  expect(mocks.render.mock.calls[0][0].chart).toMatchObject({ event: 'sell', entryTime: 1000, signalTime: 3000, bars: payload.chart.bars });
  expect(mocks.push.mock.calls[0][1].bytes).toBe(mocks.png);
  expect(mocks.lookup).toHaveBeenCalled();
  expect((await deliverTvAlert({ ...payload, chart: { ...payload.chart, bars: [] } }, hook)).forwarded).toBe(true);
  expect(mocks.render.mock.calls[1][0].chart).toBeUndefined();
  expect(mocks.push).toHaveBeenCalledTimes(2);
});
it('买点附图通过 RPS 闸门后才渲染并发送，缺图不影响合格信号', async () => {
  const payload = { event: 'buy', symbol: 'CF', tf: '240', price: 110, kind: 1, barTime: 3000,
    chart: { version: 1, stride: 1, bars: [[1000, 2000, 100, 105, 99, 104, 98, 97, 92, 90], [2000, 3000, 104, 112, 100, 110, 99, 98, 93, 91]] } };
  mocks.lookup.mockReturnValue({ rps: 5 });
  expect(await deliverTvAlert(payload, hook)).toMatchObject({ forwarded: false });
  expect(mocks.render).not.toHaveBeenCalled();
  mocks.lookup.mockReturnValue({ rps: 90 });
  expect(await deliverTvAlert(payload, hook)).toMatchObject({ forwarded: true });
  expect(mocks.render.mock.calls[0][0].chart).toMatchObject({ event: 'buy', signalTime: 3000, signalPrice: 110 });
  expect(mocks.push.mock.calls[0][1].bytes).toBe(mocks.png);
  expect(await deliverTvAlert({ ...payload, chart: null }, hook)).toMatchObject({ forwarded: true });
  expect(mocks.render.mock.calls[1][0].chart).toBeUndefined();
});
it.each([['book', book], ['gex', gex], ['market', market]] as const)('%s 图片接口复用 PNG 且同一份数据使用相同事件 ID', async (_, route) => {
  const payload = { filename: 'card.png', content: 'card', input: { asOf: '2026-09-09' } };
  expect((await route(request(payload))).status).toBe(200);
  expect((await route(request(payload))).status).toBe(200);
  expect(mocks.push.mock.calls[0][1].bytes).toBe(mocks.png);
  expect(mocks.push.mock.calls[0][1].eventKey).toBe(mocks.push.mock.calls[1][1].eventKey);
});
