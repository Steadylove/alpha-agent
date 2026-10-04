import path from "node:path";
import type { AgentMode } from "../../src/lib/siteAgent/types";

/** Native 0.160 profiles, passed through thread/start and thread/resume config overrides. */
export function sitePermissions(mode: AgentMode, home: string, state = process.env.SITE_AGENT_STATE_DIR || "/state") {
  const id = mode === "research" ? "site-research" : "site-workspace";
  return {
    id,
    approvalPolicy: { granular: { sandbox_approval: false, request_permissions: false,
      rules: true, skill_approval: true, mcp_elicitations: false } },
    config: { default_permissions: id, permissions: { [id]: {
      extends: mode === "research" ? ":read-only" : ":workspace",
      filesystem: { [path.resolve(home)]: "deny", [path.resolve(state)]: "deny", "/proc": "deny", "/market": "read" },
      network: { enabled: false },
    } } },
  };
}

export function verifySitePermissions(value: Record<string, unknown>, id: string): void {
  const profile = value.activePermissionProfile as { id?: unknown } | undefined;
  const approval = value.approvalPolicy as { granular?: { sandbox_approval?: unknown; request_permissions?: unknown } } | undefined;
  if (profile?.id !== id || approval?.granular?.sandbox_approval !== false || approval?.granular?.request_permissions !== false)
    throw new Error("Codex 未确认工作台隔离策略，任务未启动");
}
