import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { POST as alert } from "@/app/api/tv/alert/route";
import { deliverTvAlert } from "@/lib/signals/deliverTvAlert";
import type { AlertPayload, AlertView } from "@/lib/discord/tvAlertCopy";
import type { SectorSnapshot } from "@/lib/signals/sectorFactor";
import { POST as book } from "@/app/api/tv/render-book/route";
import { POST as gex } from "@/app/api/tv/render-gex/route";
import { POST as market } from "@/app/api/tv/render-market-state/route";
import { POST as flowDigest } from "@/app/api/tv/render-option-flow-digest/route";
import { POST as flow } from "@/app/api/tv/render-option-flow/route";

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  discord: vi.fn(),
  lookup: vi.fn(),
  snapshot: vi.fn(),
  fund: vi.fn(),
  render: vi.fn(),
  png: Buffer.from("rendered-image"),
  after: vi.fn((task: () => unknown) => task),
}));
vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return { ...actual, after: (task: () => unknown) => mocks.after(task) };
});
vi.mock('@/lib/notifications/postSignalImage', () => ({ postSignalImage: mocks.push }));
vi.mock('@/lib/discord/sendWebhook', () => ({ postDiscordImage: mocks.discord }));
vi.mock('@/lib/backtest/rpsSnapshot', () => ({
  ensureRpsSnapshot: mocks.snapshot,
  lookupAlertRps: mocks.lookup,
  resolveAlertTimeframe: (period: string) => (period === "120" || period === "2H" ? "2h" : "4h"),
}));
vi.mock('@/lib/discord/signalCardOg', () => ({ renderSignalOgPng: mocks.render }));
vi.mock('@/lib/discord/bookCardOg', () => ({ renderCashBookOgPng: async () => mocks.png }));
vi.mock('@/lib/discord/gexCardOg', () => ({ renderGexOgPng: async () => mocks.png }));
vi.mock('@/lib/discord/gexBriefCardOg', () => ({ isGexBriefView: () => true, renderGexBriefOgPng: async () => mocks.png }));
vi.mock('@/lib/discord/marketStateCardOg', () => ({ renderMarketStateOgPng: async () => mocks.png }));
vi.mock("@/lib/jobs/fundScore", () => ({ lookupAlertFundScore: mocks.fund }));
const request = (value: unknown) => new Request('https://app.test/api', { method: 'POST', body: JSON.stringify(value) });
const hook = "https://discord.example/hook";
beforeEach(() => {
  vi.resetAllMocks();
  mocks.render.mockResolvedValue(mocks.png);
  mocks.fund.mockResolvedValue(undefined);
  vi.stubEnv('DISCORD_SIGNAL_WEBHOOK_URL', hook);
});
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
it('RPS 过期时阻止新买点，卖点仍发送且不显示旧强度', async () => {
  mocks.lookup.mockImplementation(() => { throw new Error("RPS 数据过期"); });
  const payload = { event: 'buy', symbol: 'CF', tf: '240', price: 100, kind: 1, barTime: Date.now() };
  expect(await deliverTvAlert(payload, hook)).toMatchObject({ forwarded: false, gate: 'unknown', lookupError: 'RPS 数据过期' });
  expect(mocks.push).not.toHaveBeenCalled();
  expect(await deliverTvAlert({ ...payload, event: 'sell' }, hook)).toMatchObject({ forwarded: true });
  expect(mocks.render.mock.calls[0][0].rps).toBeUndefined();
});

it('旧版没有 K 线时间时不误吞另一笔同价位交易', async () => {
  const payload = { event: 'sell', symbol: 'CF', tf: '240', price: 100, kind: 1 };
  await deliverTvAlert(payload, hook); await deliverTvAlert(payload, hook);
  expect(mocks.push.mock.calls[0][1].eventKey).not.toBe(mocks.push.mock.calls[1][1].eventKey);
});
it('重放旧买点不会将当前财务和强度当作历史评分资料', async () => {
  mocks.lookup.mockReturnValue({ rps: 90 });
  await deliverTvAlert({ event: 'buy', symbol: 'CF', tf: '240', kind: 1, price: 100, barTime: 1000 }, hook);
  expect(mocks.fund).not.toHaveBeenCalled();
  expect(mocks.render.mock.calls[0][0].quality.available).toBe(0);
  expect(mocks.render.mock.calls[0][0].rps).toBeUndefined();
});
it('实时买卖点均不再请求财务服务', async () => {
  mocks.lookup.mockReturnValue({rps:90});
  for(const event of ['buy','sell']) await deliverTvAlert({event,symbol:'CF',tf:'240',kind:1,price:100,barTime:Date.now()},hook);
  expect(mocks.fund).not.toHaveBeenCalled();
  expect(mocks.render.mock.calls.every(call=>!call[0].fund)).toBe(true);
});

describe("正式买点投递采用 V5 板块共振", () => {
  const signalTime = Date.parse("2026-09-18T16:00:00Z");
  const asOf = "2026-09-17";
  let dir: string;
  const sectorSnapshot = (): SectorSnapshot => ({
    version: 1, asOf, generatedAt: "2026-09-18T10:00:00Z", membershipAsOf: asOf, membershipSource: "fixture",
    classification: { NVDA: "TECH" },
    sectors: [{ id: "TECH", name: "科技", etf: "XLK", relative20: .03, percentile: .8,
      above50: 12, valid: 20, total: 20, breadth: .6, points: 10.5 }],
  });
  const buyPayload = (tf = "240"): AlertPayload => ({
    event: "buy", symbol: "NVDA", tf, kind: 1, price: 100, atr: 2, stopMult: 4,
    barTime: signalTime, entrySignalTime: signalTime, strategyKey: `delivery-${tf}`,
  });
  const renderedView = () => mocks.render.mock.calls.at(-1)![0] as AlertView;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "signal-delivery-v5-"));
    vi.stubEnv("SIGNAL_JOURNAL_DIR", dir);
    vi.spyOn(Date, "now").mockReturnValue(signalTime);
    mocks.lookup.mockReturnValue({ rps: 80, asOf, generatedAt: "2026-09-18T10:00:00Z", sourceTimeframe: "1d", benchmark: "SP500" });
    mocks.snapshot.mockResolvedValue({ sector: sectorSnapshot() });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  it.each(["120", "240"])("%s 买点实际交给渲染器的是五项 V5，止损独立保留", async (tf) => {
    expect(await deliverTvAlert(buyPayload(tf), hook)).toMatchObject({ forwarded: true, gate: "pass" });
    const view = renderedView();
    expect(view.quality?.version).toBe("quality-v5");
    expect(view.quality?.dimensions.map(({ name, max }) => [name, max])).toEqual([
      ["强度", 30], ["位置", 25], ["量价压力", 20], ["板块共振", 15], ["成交分布", 10],
    ]);
    expect(view.quality?.dimensions.find(d => d.name === "板块共振")?.points).toBe(10.5);
    expect(view.quality?.dimensions.some(d => /风险|止损/.test(d.name))).toBe(false);
    expect(view.stop).toBe(92);
    expect(view.assessment?.heading).not.toMatch(/候选|试算/);
    expect(mocks.push).toHaveBeenCalledWith(hook, expect.objectContaining({ kind: tf === "120" ? "signal-2h" : "signal-4h", bytes: mocks.png }));
  });

  it.each(["缺失", "过期", "事后生成", "归属未知"])("板块%s仍投递 V5，但不给板块补分或改回止损评分", async (scenario) => {
    const sector = sectorSnapshot();
    if (scenario === "过期") sector.asOf = "2026-09-16";
    if (scenario === "事后生成") sector.generatedAt = "2026-09-18T17:00:00Z";
    if (scenario === "归属未知") sector.classification = {};
    mocks.snapshot.mockResolvedValue(scenario === "缺失" ? {} : { sector });
    expect(await deliverTvAlert(buyPayload(), hook)).toMatchObject({ forwarded: true });
    const quality = renderedView().quality;
    expect(quality?.version).toBe("quality-v5");
    expect(quality?.dimensions.find(d => d.name === "板块共振")).toMatchObject({ max: 15, points: null });
    expect(quality?.dimensions.some(d => d.name === "风险")).toBe(false);
    expect(quality?.available).toBe(30);
    expect(quality?.points).toBe(24);
    expect(quality?.label).toBe("资料未齐");
  });

  it("旧协议缺少交易标识时仍使用实时 V5，不依赖成功写入快照", async () => {
    await deliverTvAlert({ ...buyPayload(), strategyKey: undefined, entrySignalTime: undefined }, hook);
    const view = renderedView();
    expect(view.quality?.version).toBe("quality-v5");
    expect(view.quality?.dimensions.find(d => d.name === "板块共振")?.points).toBe(10.5);
    expect(view.assessment?.note).toContain("入场关联信息缺失");
  });
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
it("4H / 2H 告警带上对应推送类型，由配置决定是否抄镜像", async () => {
  await deliverTvAlert({ event: "sell", symbol: "CF", tf: "240", price: 100, kind: 1, barTime: 1 }, hook);
  expect(mocks.push).toHaveBeenCalledWith(hook, expect.objectContaining({
    filename: "signal-CF.png",
    kind: "signal-4h",
    bytes: mocks.png,
  }));
  mocks.push.mockClear();
  await deliverTvAlert({ event: "sell", symbol: "CF", tf: "120", price: 100, kind: 1, barTime: 2 }, hook);
  expect(mocks.push).toHaveBeenCalledWith(hook, expect.objectContaining({ kind: "signal-2h", bytes: mocks.png }));
});
it("账本、GEX、日结都走同一套 postSignalImage，日结默认不带镜像类型", async () => {
  expect((await book(request({ filename: "book-4h.png", content: "账本", input: { asOf: "2026-09-09" } }))).status).toBe(200);
  expect((await gex(request({ filename: "gex.png", content: "GEX", input: { asOf: "2026-09-09" } }))).status).toBe(200);
  expect((await flowDigest(request({
    filename: "option-flow-digest.png",
    content: "期权流 · 日结",
    png: mocks.png.toString("base64"),
  }))).status).toBe(200);
  expect(mocks.push.mock.calls.map((call) => call[1].kind)).toEqual(["book", "gex", "option-flow-digest"]);
  expect(mocks.discord).not.toHaveBeenCalled();
});
it("期权流单笔接口走买卖卡同一套 postSignalImage", async () => {
  const png = Buffer.from("flow-card").toString("base64");
  expect((await flow(request({
    filename: "option-flow.png",
    content: "期权流 · 单笔",
    eventKey: "option-flow:t1",
    png,
  }))).status).toBe(200);
  expect(mocks.push).toHaveBeenCalledWith(hook, {
    kind: "option-flow",
    filename: "option-flow.png",
    content: "期权流 · 单笔",
    eventKey: "option-flow:t1",
    bytes: Buffer.from(png, "base64"),
  });
});
it("期权流日结接口缺图时返回 400，不加载出图模块", async () => {
  expect((await flowDigest(request({ filename: "option-flow-digest.png" }))).status).toBe(400);
});
it("期权流日结接口复用 PNG 且同一份数据使用相同事件 ID", async () => {
  const payload = {
    filename: "option-flow-digest.png",
    content: "期权流 · 日结",
    eventKey: "option-flow-digest:2026-09-11",
    png: Buffer.from("digest-card").toString("base64"),
  };
  expect((await flowDigest(request(payload))).status).toBe(200);
  expect((await flowDigest(request(payload))).status).toBe(200);
  expect(mocks.push.mock.calls[0][1].bytes.equals(Buffer.from("digest-card"))).toBe(true);
  expect(mocks.push.mock.calls[0][1].eventKey).toBe(mocks.push.mock.calls[1][1].eventKey);
});
