import { NextResponse } from "next/server";
import { runRpsLeaderboardJob } from "@/lib/jobs/rpsLeaderboard";

export async function POST(request: Request) {
  const secret = request.headers.get("x-cron-secret");
  if (!process.env.CRON_SECRET) {
    return NextResponse.json({ error: "CRON_SECRET is not configured." }, { status: 503 });
  }
  if (secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const result = await runRpsLeaderboardJob();

  const compact = (rows: (typeof result.boards)[20]) =>
    rows.slice(0, 10).map((r) => ({
      rank: r.rank,
      symbol: r.symbol,
      rps: Number(r.rps.toFixed(1)),
      ret: Number((r.ret * 100).toFixed(1)),
    }));

  return NextResponse.json({
    ok: true,
    universeSize: result.universeSize,
    rankedSize: result.rankedSize,
    dailyFetchErrors: result.dailyFetchErrors,
    barsPersisted: result.barsPersisted,
    eliteCount: result.elite.length,
    elite: result.elite.map((r) => ({
      symbol: r.symbol,
      rps20: Number(r.rps20.toFixed(1)),
      rps50: Number(r.rps50.toFixed(1)),
      rps120: Number(r.rps120.toFixed(1)),
      rps250: Number(r.rps250.toFixed(1)),
    })),
    top10: {
      20: compact(result.boards[20]),
      50: compact(result.boards[50]),
      120: compact(result.boards[120]),
      250: compact(result.boards[250]),
    },
  });
}
