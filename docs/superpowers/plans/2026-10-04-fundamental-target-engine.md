# Fundamental Target Engine Implementation Plan

> **For agentic workers:** Implement the bounded tasks below in parallel where file ownership is independent; review each boundary before integration. The optional superpowers execution skills referenced by the planning template are not installed in this session.

**Goal:** Add an independent, cached fundamental valuation service and website readout without changing trading, accounting or notification decisions.

**Architecture:** A VPS job collects dated financial evidence for the signal pool/holdings, computes versioned valuations and optionally asks DeepSeek to explain the verified result. The website reads saved output only. V1 supports profitable non-financial USD companies using forward earnings scenarios and a same-industry, same-basis forward P/E peer anchor; unsupported or insufficient evidence stays unavailable.

**Tech Stack:** TypeScript, Zod, existing JSON snapshot storage, FMP, DeepSeek, Next.js, systemd, Vitest.

## Scope and fixed rules

- No strategy, score, account, stop, Discord or Telegram changes. 2H/4H use one symbol valuation.
- Reuse daily stored evidence. No webpage visit invokes a vendor or LLM. Collector failures retain the last successful version, visibly stale.
- 6M/12M refer to dated horizons; earnings for the twelve months following each horizon are prorated from contiguous fiscal-year consensus estimates. This uniform accrual assumption is visible, not a prediction of the price path.
- Same-basis peer Forward P/E quartiles anchor Bear/Base/Bull multiples; do not multiply GAAP historical P/E by non-GAAP consensus EPS. Limit confidence. No RPS/price momentum inputs. 20/55/25 are scenario weights, not calibrated probabilities.
- Require actual profitability, positive FCF, sufficient forecast coverage, analyst coverage and dated financial evidence and a verified peer sample. Financials/REITs, suspicious non-operating profits, unsupported currencies and missing evidence do not receive invented values.
- Important source changes, estimates, earnings, material event review, or 90-day expiry trigger revaluation. Quote-only movement does not change the target.
- History is immutable. Historical signal association can only select versions published at/before the signal; first-time later research cannot backfill known-at-entry values.
- Exact EPS normalization and separate P/B, EV/EBITDA, EV/Sales/DCF models require their own verified inputs; V1 reports its coverage boundary.

## Tasks and verification

- [x] Types/engine: `src/lib/fundamental/types.ts`, `engine.ts`, `tests/fundamentalEngine.test.ts`. Validate deterministic 6M/12M calculations, missing/negative/future inputs, quote-independent fingerprints, scenario order and attribution reconciliation. Run `npx vitest run tests/fundamentalEngine.test.ts`.
- [x] Data: `src/lib/fundamental/providers.ts`, `tests/fundamentalProviders.test.ts`. Confirm official endpoint fields; collect bounded vendor responses with clean public source URLs, fiscal/filing dates and explicit health. Use fixtures for incomplete, denied, malformed and future data. Never log provider credentials or response bodies on errors.
- [x] State/service: `src/lib/fundamental/store.ts`, `service.ts`, `tests/fundamentalStore.test.ts`, `fundamentalService.test.ts`. Archive immutable versions then atomically publish current status; deduplicate by material evidence; retain old result on failure; reject retrospective data. Explain stale/pending/unavailable separately.
- [x] AI: `src/lib/fundamental/analyst.ts`, `tests/fundamentalAnalyst.test.ts`. DeepSeek receives only collected financial evidence and computed scenarios, emits cited drivers/risks/summary in validated JSON, cannot set targets/weights/multiples or issue Buy/Hold/Sell recommendations. AI failure leaves numerical output readable.
- [x] Website: `src/components/fundamental/*`, `src/app/api/fundamental/[symbol]/route.ts`, desk integration and SSR tests. Lazy independent data loading, mobile layout, current-versus-entry distinction, source links and history. Do not modify push image templates.
- [x] Job/runtime: `scripts/build-fundamental-targets.ts`, independent shell/service/timer, runtime bundle registration, package command, deployment installation. A separate lock, bounded per-run symbol count, sequential vendor requests and retry interval prevent duplicate paid work. Test shell syntax and compile bundle without executing senders.
- [x] Documentation: `docs/fundamental-target-engine.md` with prerequisites, forecast/multiple formula, status meanings, manual dry-run/run commands, environment keys and limitations.
- [x] Review: focused tests, `npm run typecheck`, touched-file lint, full regression suite, runtime build and website rendering. Check diff for changes to any trade/push path; preserve pre-existing untracked `output/` and `src/generated/`.

## Operational boundary

This turn develops and verifies the module locally. Actual vendor-account coverage must be checked without printing keys; deployment/paid backfill status must be reported separately from tests. Do not claim current production targets exist before a successful collection.

## Completed validation

- Full suite: 152 files / 1,461 tests passed. Subsequent integration/diagnostic changes passed their focused suites (23 and 27 tests).
- Production Next.js build, TypeScript, touched new-module ESLint, runtime bundle (12 jobs / 3 services), shell syntax and diff whitespace checks passed. Existing file-tracing warnings from the account route remain unrelated.
- Local desktop/mobile preview verified target cards, methodology, source/history disclosure and signal-desk navigation; preview used synthetic ACME evidence, not live investment output.
- Actual local FMP credentials could read MSFT/ADBE own fundamentals, but valid peers were insufficient: ORCL statements/estimates and company-screener returned HTTP 402. No real target, paid AI backfill or production deployment was claimed.
- Production deployment and data entitlement resolution remain operational next steps, outside this local implementation.
