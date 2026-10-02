# Alpha Agent Server Migration Implementation Plan

**Goal:** Move the running application from `108.174.50.53` to `192.210.241.6`, preserve account and delivery history, and restore a matching website/server release.

**Architecture:** Copy persistent data and verified CI artifacts over SSH, then stop old writers for a final state transfer. Start the new services only after that transfer. Keep the old HTTP endpoint as a temporary reverse proxy while the website and deployment workflow move to the new address.

**Tech Stack:** SSH, tar, Docker Compose, Node 22, systemd timers, GitHub Actions, Vercel.

## Steps

- [x] Verify passwordless SSH, host identity, free disk/memory and existing services. New host has unrelated services; preserve them.
- [x] Temporarily stop the four old Alpha timers and wait for active data tasks. Copy market, desk, Telegram queues/configuration, credentials, logs, work cache and rollback files without printing secret contents. Restore old timers if cutover must wait.
- [x] Copy the existing working runtime and the verified `d501522` CI release. Validate checksums, Node/native modules, fonts and compose configuration before starting workers.
- [x] Quiesce old Telegram/option-flow senders and old account/desk writers; sync their final files. Preserve permissions, bot identity, cursors, receipts and systemd timer timestamps.
- [x] Start new services and verify HTTP health, market metadata and immutable state checksums. Point the old nginx endpoint at the new server so callers of the old address use the same writers.
- [ ] Update `app.config.ts` and HOST in `.github/workflows/{deploy-market,daily-quant-jobs,daily-screener}.yml`; adjust the two existing address assertions. Run affected tests and type checking, then commit/push for deployment.
- [ ] Confirm CI activation, website freshness, saved account continuity and next timer executions. Keep old senders/timers stopped. Do not manually resend messages as part of verification.

## Recovery

Keep the old data and runtime untouched as rollback evidence. Before cutover, old timers can be re-enabled if preparation fails. After new writers start, never restart old writers against their stale copy: stop new writers, sync their latest queues/account state back, then restore the old nginx configuration and services. Preserve the prior nginx configuration and all timer state under a dated migration backup.

## Checks

Use `verify-runtime.mjs` without importing sender entrypoints; GET health endpoints and inspect only metadata. Compare market manifests plus desk/Telegram file hashes before new writers start. Preserve saved fills, positions, cash and equity when the new signal tracking state is first initialized. The website-only audit display must not change notification card templates.

## Preparation checkpoint — October 2, 2026

- New host: Ubuntu 24.04, amd64, Node 22.22.3, Docker Compose available; unrelated IBKR/proxy services retained.
- `market/`: 2,704 files, 2,117,260,447 bytes; both hosts produce aggregate SHA-256 `14fffaa23601678910dba9b51dc1cb8a0d6312eb27535bc2f948d04fa3297527`. Work cache, logs, private backups and copied private configuration also matched aggregate checksums during the paused snapshot.
- Existing working runtime retained on the new host. Prepared runtime and imported image: `d50152296b0b399f18cd127ec10632846d2a396d-36843127152-1`. Archive checksums, runtime smoke tests (11 jobs), native image rendering and Compose configuration pass. No Alpha containers or timers have been started on the new host.
- Initial `desk/` and `telegram/` snapshots copied. They are not the final cutover state: freeze old writers and copy again immediately before activation.
- Public host references changed in the six scoped source/workflow/test files; 31 affected tests and TypeScript pass. Changes are not committed or pushed yet.
- Automatic approval initially rejected opening public TCP 8787. The user explicitly approved it before the firewall rule or public services were enabled.

## Cutover checkpoint — October 2, 2026, 02:01 UTC

- Old timers are disabled and old `alpha-option-flow`, `alpha-telegram`, `alpha-book`, and `alpha-desk` containers are stopped. Only the old nginx remains as a bridge to the new endpoint.
- After freezing writers, final checksums matched for all 126 desk files, 447 Telegram files and both private identity/configuration files. Four timer timestamps were copied with their modification times. No market files changed after the verified first copy.
- All five new services passed health checks. Both old and new public endpoints serve the same market manifest and reach the same workers. The unrelated IBKR containers remain healthy.
- A same-cutoff refresh initialized engine 5 tracking for 73 symbols in each timeframe. Both complete financial checkpoint hashes match their originals; 4H retains 101 fills and 2H retains 36. Account display fields and all existing curve points also match. Website reports `stale:false`.
- No manual notification was sent as a migration test. Existing automated sender processing resumes solely on the new server.
- Remaining publication check: push the six scoped address changes plus this record, confirm successful CI activation on the new host, and inspect the four timer schedules after deployment.
