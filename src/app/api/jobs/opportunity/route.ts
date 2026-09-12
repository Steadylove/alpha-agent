import { NextResponse } from "next/server";

import { opportunityJobResult, runOpportunityJob } from "@/lib/jobs/opportunity";

export async function POST(request: Request) {
  const secret = request.headers.get("x-cron-secret");
  if (!process.env.CRON_SECRET) {
    return NextResponse.json({ error: "CRON_SECRET is not configured." }, { status: 503 });
  }
  if (secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const data = await runOpportunityJob();
  return NextResponse.json({ ok: true, ...opportunityJobResult(data) });
}
