import { runDailyReportJob } from "@/lib/jobs/dailyReport";
import { NextResponse } from "next/server";

export async function POST(request: Request) {
  const secret = request.headers.get("x-cron-secret");

  if (process.env.CRON_SECRET && secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const result = await runDailyReportJob();
  return NextResponse.json({
    ok: true,
    title: result.report.title,
    errors: result.errors,
  });
}
