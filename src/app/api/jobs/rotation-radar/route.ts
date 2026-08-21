import { NextResponse } from "next/server";
import { runRotationRadarJob } from "@/lib/jobs/rotationRadar";

export const maxDuration = 300;

export async function POST(request: Request) {
  const secret = request.headers.get("x-cron-secret");
  if (!process.env.CRON_SECRET) {
    return NextResponse.json({ error: "CRON_SECRET is not configured." }, { status: 503 });
  }
  if (secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const result = await runRotationRadarJob();

  return NextResponse.json({
    ok: true,
    latestDate: result.latestDate,
    symbolsEvaluated: result.symbolsEvaluated,
    symbolsSkipped: result.symbolsSkipped,
    activePositions: result.activePositions,
    firedToday: result.firedToday,
    exitedToday: result.exitedToday,
    stateRowsWritten: result.stateRowsWritten,
    tradeRowsWritten: result.tradeRowsWritten,
  });
}
