import { forwardAgentRequest } from "@/lib/siteAgent/gateway";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = (request: Request) => forwardAgentRequest(request, "status");
