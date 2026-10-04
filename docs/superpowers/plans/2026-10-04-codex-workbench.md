# Codex Website Workbench Implementation Plan

**Goal:** Add an owner-only Codex workbench to Trend Adaptive with persistent conversations, native tool execution and approvals, subscription quota visibility, and website-specific guidance.

**Architecture:** An independent non-root VPS service controls the official Codex CLI through its local stdio app-server protocol. A protected Next.js gateway exposes a fixed application API; the browser cannot send arbitrary Codex RPC. Codex works in an isolated project copy with selected read-only market snapshots and separate session storage. Existing trading, collection, notification and valuation jobs remain independent.

**Tech Stack:** TypeScript, Next.js, Node HTTP, Codex CLI app-server, JSON archive storage, Docker/systemd, Vitest.

## Contract and ownership

- `src/lib/siteAgent/types.ts`: shared public response/request contracts; excludes credentials and model reasoning.
- `services/site-agent/{rpc,store,service,server}.ts`: stdio RPC lifecycle, bounded local persistence, conversation orchestration, HTTP allowlist and bearer authentication.
- `src/lib/siteAgent/{auth,gateway}.ts`, `src/app/api/agent/**`: owner authentication, secure cookie, origin checks and authenticated VPS forwarding.
- `src/components/agent/*`, `src/app/agent/page.tsx`, `src/components/SiteNav.tsx`: login, threads, messages, tool/approval status, models, native quota and application budgets.
- `deploy/site-agent/*`: pinned official CLI runtime, non-root isolated deployment, project guidance and domain skills.
- `tests/siteAgent*.test.ts`: RPC lifecycle, persistence, budget enforcement, authentication, cross-origin requests and request validation.

## Implementation

- [x] Verify official CLI schema and server prerequisites without reading existing credentials.
- [x] Define a stable REST contract: status; thread list/create/read/rename/archive; message submission; interrupt; approval response; settings; device login status. Only registered local thread IDs may be accessed.
- [x] Implement a bounded JSON-RPC client with timeouts, process exit recovery, and an explicit deny response for unknown server requests. Never persist reasoning events.
- [x] Implement thread persistence and resume; messages and terminal outcomes survive service restart. Active turns interrupted by restart receive an explicit interrupted status.
- [x] Enforce one active turn by default, request size limits, task duration limit and daily request cap. Token budgets are an observed soft limit, never represented as prepaid balance or a guaranteed hard spend cap.
- [x] Read quota windows from `account/rateLimits/read`; preserve unknown values and show each supplied window duration/reset time. API-only or unavailable quota remains unavailable.
- [x] Add isolated owner login with a server-side secret, expiring HttpOnly session cookie, same-origin mutation checks, constant-time verification and bounded login attempts. Disable the gateway when not configured.
- [x] Build the independent workbench using the site's existing dark editorial styling, with mobile navigation and transparent disconnected/login-required states.
- [x] Add project instructions and focused research/diagnostics/development skills. Grant no host root, Docker socket, SSH key or existing sender credentials to the agent.
- [ ] Run targeted unit tests, TypeScript and changed-file lint; smoke-test native CLI initialization, quota access and a small authenticated real turn when the user finishes device authorization.
- [ ] Preview and inspect desktop/mobile UI. Install only the isolated service and scoped configuration after checks; do not trigger existing notifications or trading jobs.

## Acceptance

1. Unauthenticated visitors cannot read threads, account quota, logs or invoke tools.
2. A logged-in owner can create and resume a conversation, send a message, observe progress, cancel, rename and archive it.
3. Required Codex approvals appear with the command/change being approved and never auto-accept.
4. Quota values come from the authenticated Codex account; local budget settings and request/token usage are labeled separately.
5. Existing page data and scheduled jobs remain usable when the Agent service or model fails.
6. No secrets or external-source instructions are treated as trusted website guidance.

## Trial status

- 49 Agent tests and 10 environment tests passed; frontend production build, TypeScript, changed-file lint and desktop/mobile preview passed.
- Real gateway-to-VPS session create/read/rename/archive and budget roundtrip passed without model calls.
- Native app-server initialization and model catalogue passed; account authorization and real conversation/quota acceptance remain pending.
- Isolated VPS container is installed and only exposed over a loopback SSH tunnel. Existing production jobs are unchanged.
- Native Linux synthetic isolation passed after explicit user approval on 2026-10-04. Dedicated seccomp/AppArmor profiles are active only on the Agent container. Credential/state/proc and symlink reads, market overwrite/delete, and inner TCP access are denied; research is read-only and workspace mode can write its isolated directory. Boot persistence remains separately pending approval. Actual subscription task acceptance is in progress.
- Public Vercel deployment has not been performed. Production configuration requires its own compatible configuration scope and HTTPS worker entry, as documented.
- Selected real review/fundamental/context/bars snapshots were read successfully. The latest Catalyst helper handled the 6.4 MB archive as a bounded 56 KB projection in a read-only probe; this last helper update is pending the next worker image refresh.
