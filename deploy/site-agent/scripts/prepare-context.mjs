#!/usr/bin/env node
// Small explicit build context: never copy .git, production data, local credentials or outputs.
import { lstatSync, mkdirSync, readdirSync, copyFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const destination = process.argv[2];
if (!destination || !path.isAbsolute(destination) || existsSync(destination)) throw new Error("Supply a new absolute context directory");
const bundle = path.join(project, "dist/site-agent/site-agent.mjs");
if (!existsSync(bundle)) throw new Error("Build dist/site-agent/site-agent.mjs first");
mkdirSync(destination, { recursive: true });
const excluded = name => name.startsWith(".env") || [".git", ".vercel", ".next", "node_modules", "__pycache__"].includes(name)
  || /(?:^|[.-])(?:secret|secrets|credentials)(?:[.-]|$)/i.test(name) || /\.(?:pem|key|p12|log)$/.test(name)
  || name === "telegram.config.mjs";
function copyTree(from, to) {
  if (path.relative(project, from) === path.join("src", "generated")) return;
  const stat = lstatSync(from);
  if (stat.isSymbolicLink()) throw new Error("Build context contains a symbolic link");
  if (stat.isDirectory()) {
    mkdirSync(to, { recursive: true });
    for (const name of readdirSync(from)) if (!excluded(name)) copyTree(path.join(from, name), path.join(to, name));
  } else if (stat.isFile()) { mkdirSync(path.dirname(to), { recursive: true }); copyFileSync(from, to); }
}
for (const name of ["src", "services", "scripts", "tests", "docs", "public", "deploy/site-agent",
  "package.json", "package-lock.json", "app.config.ts", "tsconfig.json", "next.config.ts", "next-env.d.ts",
  "eslint.config.mjs", "postcss.config.mjs", "vitest.config.ts", "README.md", "vercel.json"]) {
  const source = path.join(project, name);
  if (existsSync(source)) copyTree(source, path.join(destination, "project", name));
}
copyFileSync(bundle, path.join(destination, "site-agent.mjs"));
copyFileSync(path.join(project, "deploy/site-agent/Dockerfile"), path.join(destination, "Dockerfile"));
copyTree(path.join(project, "deploy/site-agent/workspace"), path.join(destination, "guidance"));
mkdirSync(path.join(destination, "scripts"));
copyFileSync(path.join(project, "deploy/site-agent/scripts/site-data.mjs"), path.join(destination, "scripts/site-data.mjs"));
copyFileSync(path.join(project, "deploy/site-agent/scripts/verify-sandbox.mjs"), path.join(destination, "scripts/verify-sandbox.mjs"));
copyFileSync(path.join(project, "deploy/site-agent/scripts/entrypoint.sh"), path.join(destination, "scripts/entrypoint.sh"));
console.log(destination);
