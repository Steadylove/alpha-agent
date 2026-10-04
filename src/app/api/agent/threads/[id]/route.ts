import { forwardAgentRequest } from "@/lib/siteAgent/gateway";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };
export async function GET(request: Request, context: Context) {
  return forwardAgentRequest(request, "getThread", await context.params);
}
export async function PATCH(request: Request, context: Context) {
  return forwardAgentRequest(request, "patchThread", await context.params);
}
