import { forwardAgentRequest } from "@/lib/siteAgent/gateway";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const POST = (request: Request) => forwardAgentRequest(request, "login");
