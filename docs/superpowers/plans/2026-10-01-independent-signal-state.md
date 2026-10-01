# Independent Signal State Implementation Plan

**Goal:** Keep local strategy calculation, but prevent an account's cash rejection from changing the strategy's next signal. Show execution reasons and compare local records with existing TV archives.

**Architecture:** Add an opt-in independent signal state to the live cash engine. Its lifecycle never receives portfolio rejection/rotation decisions. The account applies its existing capacity, pool and RPS rules to those signals. Research defaults, ATR settings, historical cash, fills and equity are preserved. This replaces the withdrawn TV-webhook-only proposal; no webhook intake rewrite is included.

**Tech Stack:** TypeScript, existing generator/checkpoint engine, Next.js, VPS JSON store, Vitest.

## Tasks and ownership

- [x] Engine: `rotate.ts`, `rotateCheckpoint.ts`, `signalTracking.ts`, focused tests. Add `separateSignalState` with a persisted independent single-symbol lifecycle. Rejecting an account order must not cancel the strategy lifecycle. An account-only RPS exit must not permit re-entry during the same strategy lifecycle.
- [x] Migration: replay only signal state through the stored cutoff, preserving existing account cash/fills/equity. Existing unmatched positions retain their original risk management and are explicitly identified as legacy. Replay new pool members before allowing future signals, including runs without a new bar.
- [x] Reconciliation: `signalReconciliation.ts` / store, authenticated desk read-only review index and compact batch, tests. Compare timeframe, encoded parameters, signal timestamps and trade association against existing immutable TV snapshots. Missing snapshots mean unverified coverage, not proven notification loss.
- [x] Live integration: `liveBookContinuation.ts`, `liveBooks*.ts`. Enable independent signals for live continuation, validate/retain tracking checkpoints and historical archives. Each account computation saves a freshly generated report with its own timestamp/coverage; page reads use the saved report rather than re-fetching the journal.
- [x] UI: `FundBoard.tsx`, `BookSignalAudit.tsx`. Present local signal lifecycle separately from simulated execution, skipped reasons, legacy holdings and concrete reconciliation differences.
- [x] Validate: RTX/GS reject-then-second-condition must not reopen the same lifecycle; GOOG/CSCO no-new-signal must not catch up; next valid lifecycle can enter; restart/repeated run equivalent; old cash/fills/curve unchanged; RPS exits remain explicit; archived/missing TV evidence never creates false matched claims.
- [x] Verify types, targeted tests, lint and runtime bundle; use cached price-bar replay for RTX/GS/GOOG/CSCO. No production activation in this change. ATR, allocation and production history have not been changed.

## Acceptance example

```text
Signal A starts -> account rejects for insufficient cash -> signal A remains active.
Another raw buy condition during A -> no new signal and no account buy.
Signal A ends -> account has no position, so no account sell.
Later signal B starts -> account independently evaluates current capacity.
```

The local and TV calculations can still differ because of source prices, parameters or available history. Reconciliation must show those differences rather than promise identical signals.

## Validation evidence

Cached market data through September 30 was replayed for the technical lifecycle only, with RPS held at 100 to isolate price/RSI/Vegas/risk behavior. This is not a replay of the production cash portfolio.

| Symbol / timeframe | Independent technical lifecycle observed |
| --- | --- |
| RTX / 2H | September 18 buy → September 30 stop; September 29 repeated raw condition does not create a second cycle. |
| GS / 2H | September 21 buy → September 29 stop; September 25 repeated raw condition does not create a second cycle. |
| GOOG / 2H | September 2 buy → September 23 stop; no new technical buy afterward. |
| GOOG / 4H | Prior August 28 cycle remains active; September 11 raw condition is not a new cycle. |
| CSCO / 2H | September 3 buy → September 22 stop; no new technical buy afterward. |
| CSCO / 4H | September 25 buy remains in its own cycle. |

All six replay cases preserve the entire old account checkpoint during signal-only migration and remain identical after a repeated run. Separate deterministic tests cover actual cash rejection, pool/RPS rejection, legacy positions/orders, restart and entry/exit associations.

The complete suite passed its non-HTTP tests; five suites requiring localhost listeners were then rerun with permission and all 29 tests passed. Type checking, focused lint, UI SSR checks and compilation of 11 jobs plus 3 services passed. Full production-portfolio export was rejected by automatic approval review as exceeding the four-stock verification scope, so no production account was imported, migrated or overwritten.

## Follow-up review hardening

- Persist each symbol's actual last processed bar instead of resuming all signal generators at the portfolio cutoff. Consume newly available tail bars through that cutoff in the signal state only, including when no new portfolio bar exists. Refuse an unproven/missing watermark; do not replay revisions inside already processed history.
- Cancel an unfilled, nonlegacy order when late tail bars reveal that its intended next-bar execution was already missed. Record `skipped / delayed_quote`, remove the pending account association, and leave historical cash, fills and equity intact. Preserve normal next-bar execution, true halt recovery and legacy orders.
- Bound TV archive reads by metadata count, file count, total bytes, single-file bytes and elapsed time; label incomplete coverage. Strip detailed reports from history-list summaries while retaining them in full versions.
- Require real string timestamps in saved reconciliation reports. Compare TV buy kinds explicitly; absent kinds remain unverifiable rather than matched.
- Display each symbol's state cutoff, recovered-cycle explanation and delayed-order reason.

Final local verification: **144 test files / 1,355 tests passed** in one full run including localhost HTTP suites. TypeScript, changed-file ESLint, whitespace checks, current UI SSR smoke checks and the runtime bundle (11 jobs / 3 services) passed. All six cached four-symbol replay cases again preserved the old financial checkpoint during migration and were idempotent. Deterministic recovery tests exercised missing bars and ten JSON restart boundaries across five seeds. This verifies local behavior; no production account was migrated or overwritten during verification. Notification text, card templates and layouts are unchanged; the added explanations appear only on the website.
