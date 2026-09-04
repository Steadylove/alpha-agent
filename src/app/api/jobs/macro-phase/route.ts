import { NextResponse } from "next/server";
import { runMacroPhaseJob } from "@/lib/jobs/macroPhase";

export async function POST(request: Request) {
  const secret = request.headers.get("x-cron-secret");
  if (!process.env.CRON_SECRET) {
    return NextResponse.json({ error: "CRON_SECRET is not configured." }, { status: 503 });
  }
  if (secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const result = await runMacroPhaseJob();

  return NextResponse.json({
    ok: true,
    latestDate: result.latestDate,
    pathId: result.pathId,
    marketRiskScore: result.marketRiskScore == null ? null : Number(result.marketRiskScore.toFixed(2)),
    pathChanged: result.pathChanged,
    previousPathId: result.previousPathId,
    seriesLength: result.seriesLength,
    recordsWritten: result.recordsWritten,
  });
}
