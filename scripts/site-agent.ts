import { mkdirSync } from "node:fs";
import path from "node:path";
import { CodexRpc } from "../services/site-agent/rpc";
import { AgentStore } from "../services/site-agent/store";
import { AgentService } from "../services/site-agent/service";
import { createAgentServer } from "../services/site-agent/server";

const workspace = path.resolve(process.env.SITE_AGENT_WORKSPACE || "/workspace");
const directory = path.resolve(process.env.SITE_AGENT_STATE_DIR || "/state");
const home = path.resolve(process.env.CODEX_HOME || "/tmp/codex-home");
const executable = process.env.CODEX_BIN || "codex";
for (const folder of [workspace, directory, home]) mkdirSync(folder, { recursive: true, mode: 0o700 });
const rpc = new CodexRpc({ executable, cwd: workspace, home });
const service = new AgentService(new AgentStore(directory), rpc, { workspace, home, executable });
const server = createAgentServer(service, process.env.SITE_AGENT_SECRET || "");
const port = Number(process.env.SITE_AGENT_PORT || "8090");
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Agent 端口配置无效");
server.requestTimeout = 35_000;
server.headersTimeout = 10_000;
server.listen(port, process.env.SITE_AGENT_HOST || "0.0.0.0", () => console.log(`Codex workbench listening on ${port}`));
for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => {
  service.close(); server.close();
  void rpc.shutdown().finally(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
});
