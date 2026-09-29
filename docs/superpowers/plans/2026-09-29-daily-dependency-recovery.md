# Daily dependency recovery implementation plan

**Goal:** Prevent an interrupted dependency installation from silently reaching the daily account and market delivery steps.

**Architecture:** Keep the existing data and delivery chain unchanged. Verify npm's installed lock marker and runtime dependencies before trusting the stamp, and bound the installer to 15 minutes with an installer-only heap cap.

**Scope:** `deploy/market-http/cron/alpha-daily-quant.sh` and its actual-Bash stub tests in `tests/dailyQuantCron.test.ts`. No schedule, strategy, automatic retry, or message-delivery changes.

- [x] Extend the stubbed Bash tests to reproduce a matching stamp with an incomplete installation, installer failure, timeout, and failed post-install verification. Assert these failures do not stamp success or reach delivery. Confirmed: all five new cases fail on the original script while its eleven existing cases pass.
- [x] Add dependency verification, start/completion/failure logs, and `timeout --kill-after=30s 15m env NODE_OPTIONS=--max-old-space-size=256 npm ci --omit=dev --no-audit --no-fund --prefer-offline --maxsockets=2`. Remove the stamp before installation and write it only after verification succeeds. Runtime workers omit development dependencies; complete application builds remain in CI.
- [x] Run the focused cron tests and Bash syntax check. All 16 cron tests pass; TypeScript, Bash syntax, changed-file ESLint, and `git diff --check` pass. The sanity expression also successfully loads the existing local runtime packages. A separate review found no blocking issue.

## Recovery verification

- The scheduled run started at 08:30 on September 29, but never passed dependency installation. A subsequent server reboot left an incomplete installation; no account delivery had started.
- Resource-limited server-side installation attempts did not complete. Prepared production dependencies in a Linux amd64 Node 22 container using the identical package lock, verified the archive checksum, and successfully loaded the runtime packages on the server before publishing the installation and stamp.
- Installed the guarded script and started the existing daily service once at 10:13:59 Asia/Shanghai. It targets the September 28 US trading session.
- Daily, macro, 4H, 1H, and rebuilt 2H market data completed without fetch/rebuild failures. GEX and daily-review checks passed without errors. The review retains the existing warning that 2H monthly return lacks a month-start baseline.
- Both accounts, GEX, options-flow digest, Tomorrow Map, and Options Market Map each have one successful Telegram delivery with a message ID and one attempt. The two review images also have four successful Discord message receipts. The account and GEX endpoints returned success; the daily screener completed at 10:35:45 with zero daily-fetch errors.
- DeepSeek generated and saved the September 28 analysis at 10:37:03. The daily service then finished successfully with exit status 0. No full-pipeline retry or duplicate delivery was triggered after sending began.

The observed failure is an interrupted/stalled installation with a partial dependency tree. The available evidence does not establish why the server rebooted or prove an out-of-memory event.
