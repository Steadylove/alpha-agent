#!/usr/bin/env node
/** No account, model, production data or real credentials are used by this native sandbox probe. */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, rmSync } from "node:fs";
import { createConnection } from "node:net";
import path from "node:path";
import os from "node:os";
import { spawn, spawnSync } from "node:child_process";

const root = mkdtempSync(path.join(os.tmpdir(), "site-agent-sandbox-"));
const folders = Object.fromEntries(["workspace", "codex-home", "state", "market"].map(name => [name, path.join(root, name)]));
for (const folder of Object.values(folders)) mkdirSync(folder, { mode: 0o700 });
// A separate process continues serving while spawnSync blocks this process's event loop.
const sibling = spawn(process.execPath, ["-e", `const net = require('node:net');
  const server = net.createServer(socket => { socket.on('error', () => {}); socket.end('synthetic-only'); });
  server.listen(0, '127.0.0.1', () => process.send({ port: server.address().port }));`], {
  env: { SITE_AGENT_PROBE_MARKER: "synthetic-only" }, stdio: ["ignore", "ignore", "ignore", "ipc"],
});
const checkListener = port => new Promise((resolve, reject) => {
  const socket = createConnection({ host: "127.0.0.1", port });
  socket.setTimeout(2000, () => socket.destroy(new Error("Synthetic listener timed out")));
  socket.once("connect", () => { socket.destroy(); resolve(); });
  socket.once("error", reject);
});
try {
  const port = await new Promise((resolve, reject) => {
    const finish = (error, value) => {
      clearTimeout(timer);
      sibling.off("error", failed); sibling.off("exit", exited); sibling.off("message", ready);
      if (error) reject(error); else resolve(value);
    };
    const failed = error => finish(error);
    const exited = () => finish(new Error("Synthetic listener exited before readiness"));
    const ready = message => {
      if (Number.isInteger(message?.port) && message.port > 0 && message.port <= 65535) finish(null, message.port);
    };
    const timer = setTimeout(() => finish(new Error("Synthetic listener failed to start")), 5000);
    sibling.once("error", failed); sibling.once("exit", exited); sibling.on("message", ready);
  });
  await checkListener(port);
  writeFileSync(path.join(folders["codex-home"], "synthetic-credential.json"), "not-a-real-credential");
  writeFileSync(path.join(folders.state, "synthetic-state.json"), "not-a-real-conversation");
  writeFileSync(path.join(folders.market, "fact.json"), "public-fixture");
  for (const file of ["overwrite.json", "delete.json"]) writeFileSync(path.join(folders.market, file), "public-fixture");
  symlinkSync(path.join(folders["codex-home"], "synthetic-credential.json"), path.join(folders.workspace, "credential-link"));
  symlinkSync(path.join(folders.state, "synthetic-state.json"), path.join(folders.workspace, "state-link"));
  let config = "";
  for (const [id, parent] of [["site-research", ":read-only"], ["site-workspace", ":workspace"]]) {
    config += `[permissions.${id}]\nextends = ${JSON.stringify(parent)}\n[permissions.${id}.filesystem]\n`;
    for (const [location, access] of [[folders["codex-home"], "deny"], [folders.state, "deny"], ["/proc", "deny"], [folders.market, "read"]])
      config += `${JSON.stringify(location)} = ${JSON.stringify(access)}\n`;
    config += `[permissions.${id}.network]\nenabled = false\n`;
  }
  writeFileSync(path.join(folders["codex-home"], "config.toml"), config);
  const reads = { credential: path.join(folders["codex-home"], "synthetic-credential.json"),
    state: path.join(folders.state, "synthetic-state.json"), market: path.join(folders.market, "fact.json"),
    credentialLink: path.join(folders.workspace, "credential-link"), stateLink: path.join(folders.workspace, "state-link"),
    ...(process.platform === "linux" ? { proc: `/proc/${sibling.pid}/environ`, procSelf: "/proc/self/environ" } : {}) };
  const program = `const fs = require('node:fs'); const result = {}; for (const [key,file] of Object.entries(${JSON.stringify(reads)})) {
    try { fs.readFileSync(file); result[key]='readable'; } catch(e) { result[key]=e.code; }
  } try { fs.writeFileSync(${JSON.stringify(path.join(folders.workspace, "probe-output"))}, 'synthetic'); result.workspace='writable'; } catch(e) { result.workspace=e.code; }
  try { fs.writeFileSync(${JSON.stringify(path.join(folders.market, "probe-output"))}, 'synthetic'); result.marketWrite='writable'; } catch(e) { result.marketWrite=e.code; }
  try { fs.writeFileSync(${JSON.stringify(path.join(folders.market, "overwrite.json"))}, 'changed'); result.marketOverwrite='writable'; } catch(e) { result.marketOverwrite=e.code; }
  try { fs.unlinkSync(${JSON.stringify(path.join(folders.market, "delete.json"))}); result.marketDelete='deleted'; } catch(e) { result.marketDelete=e.code; }
  const socket = require('node:net').createConnection({ host: '127.0.0.1', port: ${port} });
  let finished = false;
  const finish = value => { if (finished) return; finished = true; result.network=value; socket.destroy(); fs.writeSync(1, JSON.stringify(result) + '\\n'); };
  socket.setTimeout(2000, () => finish('ETIMEDOUT'));
  socket.once('connect', () => finish('connected'));
  socket.once('error', error => finish(error.code));`;
  for (const id of ["site-research", "site-workspace"]) {
    const result = spawnSync(process.env.CODEX_BIN || "codex", ["sandbox", "-P", id, "-C", folders.workspace, "--", process.execPath, "-e", program], {
      env: { PATH: process.env.PATH, HOME: folders.workspace, CODEX_HOME: folders["codex-home"], LANG: "C.UTF-8" },
      encoding: "utf8", timeout: 20_000, maxBuffer: 100_000,
    });
    const failed = reason => {
      console.error(JSON.stringify({ profile: id, ok: false, error: "native-sandbox-failed", detail: {
        reason, exitCode: result.status, signal: result.signal ?? null,
        stderr: (result.stderr || "").slice(0, 1500), error: result.error?.message ?? null,
        stdoutTail: (result.stdout || "").slice(-300),
      } }));
      process.exitCode = 1;
    };
    if (result.status !== 0) {
      failed("native-process-exited"); break;
    }
    const line = (result.stdout || "").trim().split("\n").at(-1);
    let output;
    try {
      output = JSON.parse(line);
      if (!output || typeof output !== "object" || Array.isArray(output)) throw new Error("Invalid probe object");
    } catch {
      failed(line ? "invalid-probe-output" : "missing-probe-output"); break;
    }
    // A failed connection is only meaningful if the same outer listener remains healthy.
    await checkListener(port);
    const denied = value => ["EACCES", "EPERM", "ENOENT"].includes(value);
    const writeDenied = value => denied(value) || value === "EROFS";
    const networkDenied = ["EACCES", "EPERM", "ECONNREFUSED", "ENETUNREACH", "EHOSTUNREACH", "ETIMEDOUT"].includes(output.network);
    const marketUnchanged = ["overwrite.json", "delete.json"].every(file => {
      try { return readFileSync(path.join(folders.market, file), "utf8") === "public-fixture"; } catch { return false; }
    });
    const ok = denied(output.credential) && denied(output.state) && output.market === "readable" && writeDenied(output.marketWrite)
      && denied(output.credentialLink) && denied(output.stateLink) && networkDenied
      && writeDenied(output.marketOverwrite) && writeDenied(output.marketDelete) && marketUnchanged
      && (process.platform !== "linux" || (denied(output.proc) && denied(output.procSelf)))
      && (id === "site-workspace" ? output.workspace === "writable" : writeDenied(output.workspace));
    console.log(JSON.stringify({ profile: id, ok, marketUnchanged, ...output }));
    if (!ok) process.exitCode = 1;
  }
} finally { sibling.kill("SIGKILL"); rmSync(root, { recursive: true, force: true }); }
