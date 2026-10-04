# Free Financial Statement Scenario Valuation Implementation Plan

**Goal:** Add a usable SEC-based fundamental valuation model without requiring paid analyst estimates, preserving existing archives and trading behavior.

**Architecture:** Introduce `sec-reported-scenario-v2` alongside the immutable `forward-peer-pe-v1` contract. SEC reported TTM financials establish an earnings baseline; explicit conservative revenue/margin assumptions produce annualized earnings-capacity scenarios at 6M/12M. At least three independent same-industry peers supply comparable reported-earnings P/E evidence. Existing local daily prices are used only for peer multiples and displayed price space. Target-company price does not determine its fair multiple or earnings. Website remains saved-results-only.

**Tech Stack:** TypeScript, Zod, SEC companyfacts/submissions, existing CSV snapshots, Next.js, Vitest; optional DeepSeek explanation.

## Execution

- [x] Add optional, versioned reported-financial inputs and scenario assumptions while retaining legacy schema key order and hashes.
- [x] Implement deterministic earnings/multiple calculations, source/freshness gates, material-update rules, model-change revision attribution, and persisted-math verification.
- [x] Add isolated SEC provider with explicit contact User-Agent, pacing/caches/circuit breaker, known-at-time financial normalization, exact fiscal alignment, supported-company checks, and actionable failures.
- [x] Connect provider selection to the existing isolated job and timer. Default new jobs to SEC; preserve explicit legacy FMP mode. Missing configuration must not fabricate results or affect strategy jobs.
- [x] Add a distinct AI contract explaining reported facts, model assumptions, peer evidence and limits; preserve v1 prompt and serialization.
- [x] Adapt page/readout to the actual model, including financial baseline, scenario inputs, annualized horizon meaning and method-change history.
- [x] Test manual formula examples, annual/YTD normalization, disclosure timing, incomplete evidence, hash/archive integrity, quote-only stability, model switch, safe configuration failure and both UI paths.
- [x] Run targeted fundamental/adjacent checks, typecheck and runtime build; independently review integration and fix actionable defects.
- [x] Validate live SEC samples with the user-provided contact identity; distinguish supported cases from coverage limits and independently recompute a real result.

## Constraints / Acceptance

- SEC facts are historical facts; scenario growth, margins and weights are explicitly uncalibrated model assumptions.
- Annualized 6M/12M earnings capacity is not a claim to have quarterly consensus or actual target-date NTM forecasts.
- Financials, REITs, ADRs, unresolved split/share bases, stale/incomplete periods and inadequate peer evidence remain unavailable.
- Keep immutable histories, no-lookahead entry reads, optional AI failure handling and 90-day/material-change refresh policy.
- Do not modify RPS, trading rules, account mathematics or notification templates. Do not commit, push or deploy as part of this request.

## Validation record

- Fundamental plus adjacent strategy/archive/runtime suite: 27 files / 297 tests passed. After the final six quarter-restatement regressions were added, the affected provider/integration/job/coverage subset passed 63 tests (including all 30 SEC provider tests).
- Full TypeScript, targeted ESLint, `next build --webpack`, and isolated runtime bundle passed. The runtime contains the existing 12 jobs and 3 services.
- Independent review verified legacy valuation IDs/input hashes/revision IDs against the pre-change implementation. Collection clock skew and incorrectly attributed Yahoo quote evidence were found and fixed.
- Isolated production preview at `http://127.0.0.1:3201/fundamental/ACME` returned HTTP 200 and rendered the demo warning, new method, reported facts, annualized context and scenario inputs. Synthetic data resides only in `/private/tmp/fundamental-sec-preview-market`. Browser automation backend was unavailable; verification used the actual server response and component render tests.
- The initial no-identity diagnostic returned a specific `SEC_USER_AGENT` missing reason with zero HTTP requests. After the user supplied a contact, local and server private configuration was updated; both environments successfully fetched official SEC data. No identity is stored in source, fixtures, or valuation archives.
- Real 2026-10-04 coverage using saved 2026-10-02 prices: ADBE and CRM ready with four valid peers each; AAPL has only one eligible peer, MSFT lacks a verifiable Q4 share denominator, and ORCL has blank incorporation metadata. These three remain unavailable, not fabricated estimates.
- Live data exposed and fixed cash-dividend tags incorrectly triggering split protection and rejected candidates prematurely exhausting peer discovery. Real AAPL/CRM fixture regressions plus provider/engine/integration/UI/job/coverage checks: 7 files / 105 tests passed; TypeScript and targeted ESLint passed.
- Independent arithmetic verified ADBE's ten TTM amounts exactly and 44 valuation/peer/scenario values within 2.424e-13 USD. Real sample archives and HTTP page/API reads succeeded in the isolated local preview; no AI calls, production valuation publication, commit, push, or code deployment occurred.
