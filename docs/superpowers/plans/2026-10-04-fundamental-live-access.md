# Fundamental Live Access Implementation Plan

> **For agentic workers:** Continue the existing uncommitted feature with bounded, non-overlapping file ownership. Optional superpowers execution skills are not installed; use the available collaboration tools. Do not move the unfinished feature into a new worktree.

**Goal:** Resolve demonstrated request bursts and premature peer truncation, then distinguish remaining data-access blockers from implementation defects using one bounded real check.

**Architecture:** Keep valuation formulas, financial acceptance rules, archived versions, notifications and production configuration unchanged. Serialize request start slots within each provider instance, retain the existing 429 circuit breaker, and check up to the existing 20 candidate limit until 8 valid peers are found. Preserve header-only authentication. No subscription purchase or source replacement.

**Tech Stack:** TypeScript, native fetch, Vitest fake timers, existing FMP provider and coverage CLI.

## 1. Request pacing

Files: `src/lib/fundamental/requestGate.ts`, `tests/fundamentalRequestGate.test.ts`, provider integration in `src/lib/fundamental/providers.ts`.

- [x] Write tests for concurrent request slots at least 1 second apart, no delay for an idle gate, invalid intervals, and a circuit check throwing after a queued wait without poisoning the queue.
- [x] Implement `createFundamentalRequestGate(intervalMs = 1000)`, returning `(beforeStart: () => void) => Promise<void>`; queue each slot on a promise tail, wait only the remaining interval, run `beforeStart()` immediately before recording the start time. Do not retry requests or use credentials in this helper.
- [x] Call the gate inside each uncached provider request before `fetch`, then recheck the 429 flag. Default to 1000 ms; allow an explicit constructor override for deterministic tests. Retain sanitized observations and shared request caching. Test that queued requests do not reach fetch after a 429.

## 2. Peer coverage defect

Files: `src/lib/fundamental/providers.ts`, `tests/fundamentalProviders.test.ts`.

- [x] Reproduce the case where the first 8 supplier peers are unsuitable but positions 9–11 are valid. Verify they should be discovered without a paid screener fallback.
- [x] Change the supplier candidate truncation from the 8 accepted-peer limit to the shared 20 checked-candidate limit. Retain independent issuer, same industry/currency, forecast coverage checks and the 8 accepted-peer cap.
- [x] Run provider regressions covering 8 accepted peers, 20 checked candidates across discovery paths, de-duplication and 429.

## 3. Readiness verification

Files: `docs/fundamental-target-engine.md` and this plan; no production changes.

- [x] Verify official FMP documentation for current header authentication and estimate fields. Check whether saved diagnostics support a parsing bug; do not infer account entitlement from 429.
- [x] After pacing passes tests, run a single-symbol read-only coverage check using the already configured local key, save the sanitized report, stop on limiting/auth/entitlement evidence. Do not sweep all symbols again without evidence of changed access.
- [ ] If a real valuation passes all existing rules, save it to the isolated preview directory and run one bounded AI explanation; otherwise record exact missing external input and leave this acceptance incomplete.
- [x] Run focused fundamental tests, TypeScript, targeted lint and runtime bundle. Keep the local demo preview working. No commit, push or deployment unless requested.

## Result · 2026-10-04

The peer-truncation defect was reproduced before the fix, then passed with candidates 9–11 being accepted after the first 8 failed eligibility. The accepted-peer limit remains 8 and the total checked-candidate limit remains 20. Forecast field names/fiscal dates matched the official Stable API documentation; no parser change was warranted.

Request starts are now paced at 1000 ms by default per provider instance; cache hits do not use slots and queued requests recheck the existing 429 circuit before fetch. Fake-time tests cover spacing, idle intervals, rejected gates and queued cancellation. All 144 fundamental tests, TypeScript, targeted ESLint and runtime build passed. No UI code changed in this round.

One live MSFT coverage request at 02:39:49–02:39:50 UTC returned HTTP 429 on profile; the collector stopped after exactly one request. Report: `/private/tmp/fundamental-coverage-paced-2026-10-04.json`. No further online requests or AI calls were made. The real-valuation/AI acceptance remains incomplete pending restored account availability and adequate data coverage. No production configuration, snapshot, subscription, deployment or git publication changed.
