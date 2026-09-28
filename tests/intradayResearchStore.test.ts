import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gzipSync } from "node:zlib";
const mocks=vi.hoisted(()=>({files:new Map<string,string>(),fetch:vi.fn()}));
vi.mock("node:fs",()=>({existsSync:(p:string)=>mocks.files.has(p),readFileSync:(p:string)=>mocks.files.get(p)}));
vi.mock("@/lib/backtest/marketStore",()=>({marketBaseUrl:()=>"https://data.example.test"}));
import { getResearchPage, validRunId } from "@/lib/intraday/researchStore";
import { GET } from "@/app/api/intraday/research/route";
const run={id:"offline-example",profile:"price-volume",precision:"quotes",builtAt:"2026-09-28T00:00:00Z",source:"offline",from:"2026-09-01",to:"2026-09-25",signals:2001,symbols:1000};
const report={version:1,id:run.id,signalCount:2001,events:Array.from({length:2001},(_,i)=>({id:String(i)})),scenarios:[]};
beforeEach(()=>{mocks.files.clear();mocks.fetch.mockReset();vi.stubGlobal("fetch",mocks.fetch);vi.stubEnv("VERCEL","");});
afterEach(()=>{vi.unstubAllGlobals();vi.unstubAllEnvs();});
function local(name:string,value:unknown){mocks.files.set(`${process.cwd()}/data/intraday-research/reports/${name}`,JSON.stringify(value));}
describe("日内研究读取与下载",()=>{
  it("本地读取优先；页面限制证据体积，完整下载保留全部信号",async()=>{
    local("index.json",{version:1,runs:[run]});local(`${run.id}.json`,report);local(`${run.id}.page.json`,{...report,events:report.events.slice(0,500)});
    const page=await getResearchPage();expect(page.report?.events.length).toBe(500);expect(page.report?.signalCount).toBe(2001);expect(mocks.fetch).not.toHaveBeenCalled();
    const response=await GET(new Request(`http://localhost/api/intraday/research?run=${run.id}`));expect(response.status).toBe(200);expect((await response.json()).events).toHaveLength(2001);
  });
  it("生产读 VPS，不把本地旧缓存伪装为线上报告",async()=>{
    local("index.json",{version:1,runs:[run]});vi.stubEnv("VERCEL","1");mocks.fetch.mockResolvedValue(new Response("",{status:404}));
    expect((await getResearchPage()).report).toBeNull();expect(mocks.fetch).toHaveBeenCalledWith("https://data.example.test/snapshots/intraday/index.json",expect.any(Object));
  });
  it("服务错误单独显示，不能解释成没有交易",async()=>{mocks.fetch.mockResolvedValue(new Response("",{status:503}));expect((await getResearchPage()).error).toContain("503");});
  it("线上优先读取压缩预览，保持完整信号总数",async()=>{
    vi.stubEnv("VERCEL","1");
    mocks.fetch.mockResolvedValueOnce(Response.json({version:1,runs:[run]})).mockResolvedValueOnce(new Response(gzipSync(JSON.stringify({...report,events:report.events.slice(0,500)}))));
    const page=await getResearchPage();expect(page.report?.events).toHaveLength(500);expect(page.report?.signalCount).toBe(2001);
    expect(mocks.fetch.mock.calls[1][0]).toContain(`${run.id}.page.json.gz`);
  });
  it("目录有记录而文件尚未到达时不混用另一个版本",async()=>{local("index.json",{version:1,runs:[run]});mocks.fetch.mockResolvedValue(new Response("",{status:404}));expect((await getResearchPage()).error).toContain("尚未就绪");});
  it("拒绝路径穿越及未知格式",async()=>{expect(validRunId("../../.env")).toBe(false);expect((await GET(new Request("http://localhost/api/intraday/research?run=../../.env"))).status).toBe(400);expect((await GET(new Request(`http://localhost/api/intraday/research?run=${run.id}&format=raw`))).status).toBe(400);});
  it("不存在的版本返回404，空CSV仍然有明确表头",async()=>{mocks.fetch.mockResolvedValue(new Response("",{status:404}));expect((await GET(new Request("http://localhost/api/intraday/research?run=unknown"))).status).toBe(404);local(`${run.id}.json`,report);const csv=await GET(new Request(`http://localhost/api/intraday/research?run=${run.id}&format=csv`));expect(await csv.text()).toContain('"net_realized_usd"');expect(csv.headers.get("content-disposition")).toContain("attachment");});
});
