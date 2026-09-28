import { readResearchReport, validRunId } from "@/lib/intraday/researchStore";

export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  const url = new URL(request.url), id = url.searchParams.get("run") ?? "", format = url.searchParams.get("format") ?? "json";
  if (!validRunId(id) || !["json", "csv"].includes(format)) return Response.json({ error: "无效研究版本或格式" }, { status: 400 });
  try {
    const report = await readResearchReport(id);
    if (!report) return Response.json({ error: "研究报告不存在" }, { status: 404 });
    const headers = { "Content-Disposition": `attachment; filename="${id}.${format}"`, "Cache-Control": "no-store" };
    if (format === "json") return Response.json(report, { headers });
    const row = (values: unknown[]) => values.map(v=>`"${String(v??"").replaceAll('"','""')}"`).join(",");
    const csv = [row(["scenario", "symbol", "entry_utc", "exit_utc", "entry_price", "qty", "remaining", "net_realized_usd", "fees_usd", "status"]), ...report.scenarios.flatMap(s=>s.trades.map(t=>row([s.label,t.symbol,new Date(t.entryTime).toISOString(),t.exitTime?new Date(t.exitTime).toISOString():"",t.entry,t.qty,t.remaining,t.net,t.fees,t.status])))].join("\r\n");
    return new Response("\uFEFF"+csv, { headers: { ...headers, "Content-Type": "text/csv; charset=utf-8" } });
  } catch { return Response.json({ error: "研究报告暂不可用" }, { status: 503 }); }
}
