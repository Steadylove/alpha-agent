import { handleAgentSession } from "@/lib/siteAgent/gateway";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = handleAgentSession;
export const POST = handleAgentSession;
export const DELETE = handleAgentSession;
