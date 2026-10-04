# Fundamental Coverage and Analyst Evidence Implementation Plan

> **For agentic workers:** Execute the bounded tasks below in parallel where file ownership permits; review shared interfaces before integration. The user has authorized implementation and revalidation in this task.

**Goal:** Correct evidenced SEC adapter coverage defects and prevent the real CRM/ADBE analyst failures from being accepted in new explanations.

**Architecture:** Keep the current valuation method and eligibility rules. Derive financial inputs only from traceable, temporally consistent SEC facts; expand candidate discovery/selection without substituting unverified comparables. Introduce a new immutable analyst contract that grounds comparisons and references in deterministic evidence, preserving legacy archives.

**Tech Stack:** TypeScript, SEC companyfacts/submissions, Zod, Vitest, existing Next.js/API and DeepSeek service.

---

### Task 1: Reproduce financial normalization failures

Files: `src/lib/fundamental/secProvider.ts`, optional focused financial helper, `tests/secFundamentalProvider.test.ts`, targeted public SEC fixtures.

- [x] Replay saved public companyfacts from `/private/tmp/fundamental-acceptance-2026-10-04/raw` and earlier sample capture. Inspect rejected revenue, OI/CFO/CapEx, TTM, Q4 and split evidence.
- [x] Add failing regressions with minimal real records for confirmed defects. Reject mismatched currency, duplicate durations, unsupported tags, missing quarter shares and future filings.
- [x] Correct tag/period/identity handling only when equivalent concepts or valid source arithmetic are demonstrable. Preserve every source used in derived values.
- [x] Run `npx --no-install vitest run tests/secFundamentalProvider.test.ts tests/secFundamentalIdentity.test.ts` plus any new focused tests.

### Task 2: Resolve peer discovery and eligibility sequencing

Files: `src/lib/fundamental/secProvider.ts`, `src/lib/fundamental/scenarioEngine.ts` only if needed, relevant provider tests.

- [x] Distinguish directory industry membership from actual SEC classification, and missing metadata from excluded entity types.
- [x] Confirm actual peer eligibility before applying the eight-peer retained cap; retain a finite candidate budget and all existing model checks.
- [x] Add a regression in which early normalized peers fail profitability/PE while later candidates qualify, without allowing invalid peers or target/self aliases.
- [x] Replay all 76 original targets against the same quote/date baseline, reusing saved public responses and fetching only missing evidence. Record previous/current statuses and unresolved reasons, never overwrite the original acceptance report.

### Task 3: Ground new AI outputs in verified evidence

Files: `src/lib/fundamental/analyst.ts`, new focused evidence helper if useful, `src/lib/fundamental/types.ts` only if required, analyst/integration tests.

- [x] Preserve V1/V2 prompt/input bytes and archive validators; introduce a new version for new generation.
- [x] Supply deterministic comparisons with entity/metric/period/source ownership. Exclude rejected peer diagnostics from selected-peer financial evidence.
- [x] Validate outputs against their declared evidence, blocking wrong direction and unrelated sources. Prefer constrained fact selection/rendering for financial assertions over heuristic validation of arbitrary prose.
- [x] Regress the real CRM 20.22%→19.88% reversal, rejected-peer attribution, ADBE unsupported business claim, key leakage and malformed output. Keep AI failure independent of numerical publishing.

### Task 4: Integrate, verify and publish only local preview

Files: `docs/fundamental-target-engine.md`, existing isolated preview data; no production changes.

- [x] Run fundamental and integration regressions, `npx --no-install tsc --noEmit`, targeted ESLint, runtime/web builds as applicable.
- [x] Independently review normalization and analyst validation before real calls.
- [x] Use the user's existing key for bounded ADBE/CRM actual generation through the service; inspect content, archive readback and unchanged numerical fields. Do not retry to hide failures.
- [x] Save passing real examples to isolated local preview and verify API/page output; retain rejected examples only in acceptance evidence.
- [x] Update documentation with actual before/after coverage and outstanding limits. No commit, push, production deployment or notification is implied by this request.


## Completion evidence — 2026-10-04

- Financial normalization: same-period / same-accession equivalent concepts and explicit broader capital cash outflow support. Removed unsafe Q4 diluted-share averaging; missing directly reported quarter shares remain unavailable.
- Identity and peers: official 10-K cover evidence for missing incorporation metadata; frozen validated SIC directory, deterministic 24-candidate budget, eight-peer cap applied only after eligibility checks. No model thresholds relaxed.
- Original 76 targets all checked: pool ready 3/65 → 6/65 (AMAT, AMD, CRM, MU, NVDA, WMT); financial normalization 18/65 → 29/65. Combined financial inputs 19/76 → 30/76. Remaining limits documented, no claim of full coverage.
- DeepSeek V3: CRM and ADBE one actual call each, both pass; catalog selection, grounded text/source verification and save/load checked. Each sample's 105 economic numeric fields unchanged. Legacy V1/V2 archives retained.
- Verification: 29 files / 353 tests passed; TypeScript, targeted ESLint, runtime and production web builds passed. Independent financial, peer and AI reviews completed.
- Isolated preview updated through the existing service/store: 76 universe symbols plus ADBE, 77 API states verified and seven page responses checked; original three history files unchanged. No screenshot visual verification claimed.
- Reports: `/private/tmp/fundamental-hardening-2026-10-04/{validated/report.json,preview-publication.json,http-preview-check.json}`; AI evidence `/private/tmp/fundamental-v3-live-acceptance-2026-10-04-Z2b4X2/`.
- No commit, push, production deployment or notifications performed.
