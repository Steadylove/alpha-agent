# Fundamental Data and Investor Readout Implementation Plan

> **For agentic workers:** Execute the bounded tasks below with independent file ownership. Optional superpowers subskills are not installed; the current task continues the existing uncommitted feature without moving or losing its files.

**Goal:** Make the valuation preview easier to interpret and establish the actual data entitlement needed for real valuations.

**Architecture:** Keep immutable valuations and numerical rules unchanged. Derive an investor readout from saved evidence; mark explicitly configured demo symbols on server reads. Audit current FMP access locally and on the authorized VPS without logging credentials, changing subscriptions, deploying, or sending notifications.

**Tech Stack:** Existing TypeScript / React / CSS modules, JSON snapshots, FMP, DeepSeek, Vitest.

## 1. Real data readiness

- [x] Inspect local/provider and VPS FMP configuration without exposing secrets. Probe bounded profile/statements/estimates requests for representative eligible stocks; distinguish authentication, plan restrictions, missing rows and formula coverage.
- [ ] If usable credentials exist, collect 5–10 eligible symbols to an isolated local preview directory with the current engine. Do not weaken same-currency, forecast or independent-peer requirements to create output.
- [x] Keep a sanitized coverage report containing symbol, status, valid-peer count, missing fields and timestamp. If entitlement remains blocked, implement a reusable `fundamental:coverage` diagnostic command that validates candidates without LLM calls and reports exact endpoint coverage; request only the missing external input while finishing UI work.
- [x] No new data vendor or paid subscription is selected automatically. A source change must retain financial basis, fiscal periods and source dates.

## 2. Investor readout

Files: `src/components/fundamental/FundamentalPanel.tsx`, `fundamental.module.css`, a focused `readout.ts` helper, `tests/fundamentalUi.test.ts` and `tests/fundamentalReadout.test.ts`.

- [x] Front-load saved quote/time, last check, evidence as-of, low/model confidence and valid peer count. Make stale/unavailable status conspicuous and distinguish last valid valuation from current verification.
- [x] Draw an accessible horizontal scenario scale for each horizon with Bear/Base/Bull and saved quote markers. Compute positions with `100 * (value - min) / (max - min)` using a finite domain including quote and scenarios; handle coincident prices, off-range quotes and missing quote. Keep an equivalent text/table representation and avoid clipped labels on mobile.
- [x] Show one concise saved AI summary when available, followed by a few cited dependencies and uncertainties; if absent, show only deterministic model dependencies and the actual AI status. Preserve full source/method/history disclosures.
- [x] Add a clear demo banner based on server-provided `demo?: boolean`; sample upside never appears as an unlabeled real research result.
- [x] Reduce duplicated headings/footnotes, retain brand style, display the exact forecast dates and explain the target-date forward earnings convention.

## 3. Root integration and operational evidence

Files: `src/lib/fundamental/types.ts`, `store.ts`, `tests/fundamentalStore.test.ts`, `docs/fundamental-target-engine.md`.

- [x] Add optional read-only `demo` metadata to page data. Server derives it from `FUNDAMENTAL_DEMO_SYMBOLS` (comma-separated validated symbols); it does not enter valuation identity or strategy inputs. Verify non-demo snapshots remain unmarked.
- [x] Add a read-only peer sensitivity summary if supported by saved inputs: remove one peer at a time and recompute the same quartile-weighted target, report min/max and insufficient sample; do not change or calibrate the published target.
- [ ] When a real valuation is available, run one bounded DeepSeek explanation and manually check its claims against supplied evidence. No synthetic output is described as a successful real-data trial.
- [x] Run focused tests, TypeScript and touched-file lint; build the website/runtime when code paths changed. Inspect desktop/mobile preview. Keep local preview running for the user.
- [x] Document measured coverage and remaining entitlement blockers separately from implemented features. Do not commit/push/deploy in this turn unless requested.

## Measured outcome · 2026-10-04

Implemented investor readout, explicit demo metadata, numerical peer sensitivity, read-only coverage CLI, and immutable V1 AI prompt/input contracts for archive compatibility. Local desktop/mobile review and Next production build passed. After the final rate-limit hardening, all 138 focused tests, TypeScript, targeted lint and the runtime bundle passed.

The default five-symbol audit yielded zero complete real valuations: AAPL lacked valid peers and sufficient analyst coverage; MSFT encountered HTTP 429 partway through; ADBE/ORCL/CRM were rate limited before completion. The local key also returned endpoint-specific HTTP 402. A different existing VPS key returned HTTP 401 on all three bounded authentication probes; the daily job environment has no FMP key. No credentials or production configuration were changed.

The observed 429 exposed unnecessary subsequent requests. The provider now stops new requests for the rest of that job, the diagnostic reports rate-limited targets explicitly, and the service retains previous valuations as stale with a specific limit reason and the existing six-hour retry interval. Verified with simulated provider responses only; no second live sweep was run.

The two unchecked items depend on working data access with sufficient endpoint, symbol and analyst coverage. They remain unverified; fixture results do not count as a real valuation or real AI trial. The local ACME preview is explicitly labeled demo and remains running. No commit, push or deployment was performed.
