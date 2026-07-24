import { getDashboardData } from "@/lib/dashboard/data";
import { NextResponse } from "next/server";

export async function GET() {
  const data = await getDashboardData();
  return NextResponse.json(data.stocks);
}
