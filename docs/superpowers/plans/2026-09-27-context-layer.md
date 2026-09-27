# Event × Flow × Trend Context Layer Implementation Plan

> **For agentic workers:** Use the available collaboration agents to implement each bounded task; review shared contracts and integration centrally. Steps use checkbox syntax for tracking.

**Goal:** Add an evidence-based observation layer joining existing events, sampled options reports, and trend-system observations without changing trading decisions.

**Architecture:** Preserve Event, Flow, and Trend as separate sources of truth. Publish versioned, dated context sidecars from the existing independent Catalyst job; website reads saved outputs only. A same-symbol timeline distinguishes source publication, first observation, current evidence revision, and report cutoff. AI receives only bounded cited facts and has no trading tools.

**Tech Stack:** Next.js, TypeScript, Zod, Vitest, existing JSON snapshot storage and DeepSeek completion client, systemd Catalyst schedules.

## Boundaries

- No modifications to signal conditions, RPS gates, factor formulas/weights, position sizing, exits, notification recipients, or notification conditions.
- Flow is a partial sample of source reports relayed through Discord/OCR. Contract type and source-reported side do not establish institutional identity, opening/closing, or causation.
- Only actual exchange sessions define association windows. Unknown coverage is not absence. Signal capture is not brokerage execution; model holdings are not investor holdings.
- Never replace a historical report with today's facts. Save revisions before replacing an explicitly refreshed sidecar. Original Daily Review remains byte-identical.

## Task 1 — Evidence provenance and collection health

Files: `src/lib/optionFlow/types.ts`, `provenance.ts`, `store.ts`, `parseDiscord.ts`, `research/events.ts`, `scripts/option-flow-worker.ts`, relevant tests.

- [x] Record immutable `firstObservedAt`, per-version `updatedAt`, evidence hash, revision, and bounded previous evidence; legacy unknown values remain null.
- [x] Record relay time separately; unavailable source publication and trade time remain null.
- [x] Persist independent sanitized collection health for each completed poll, including successful zero-result polls.
- [x] Verify duplicate ingestion preserves observation time, content changes preserve original evidence, legacy records remain unknown, and a failed poll cannot look like healthy empty coverage.

## Task 2 — Pure Context model

Files: `src/lib/context/types.ts`, `model.ts`, `tests/context-model.test.ts`.

- [x] Join same-symbol published events and sampled Flow using ±1 actual exchange session; retain broader ±3-session observations with explicit scope.
- [x] Keep association state and Trend status separate. Provide Event-only, Flow-only, overlap, insufficient-coverage and pending-window states scoped to the observed sample.
- [x] Attach existing signal captures, model holdings and labeled RPS observations without calculating a new score.
- [x] Verify weekend/holiday boundaries, future timestamps, late capture, missing coverage, signal-time knowledge and no future historical substitution.

## Task 3 — Saved reports and cited AI

Files: `src/lib/context/store.ts`, `publish.ts`, `summary.ts`, `src/lib/catalyst/build.ts`, `src/lib/review/store.ts`, cron wrapper, tests.

- [x] Publish `snapshots/context/latest.json` and dated reports, archiving old bytes before current-day refresh. Keep original review and Catalyst digest semantics.
- [x] Read remote snapshots strictly, never fall back to stale build-machine files; date requests return that date or missing.
- [x] Prompt DeepSeek to explain only supplied facts; require valid evidence references, reject unsupported causality/instructions, save input hash/model/time and results. Website never invokes the model.
- [x] Integrate into existing independent collector/analysis timers; set the real server Flow input path. Context failures cannot hide original Review.
- [x] Verify hash reuse, invalid citations, missing-key/failure behavior, saved-report isolation and dated read behavior.

## Task 4 — Website

Files: Context components and `/context/[symbol]`, `FlowResearchBoard.tsx`, `CatalystMonitor.tsx`, `DailyReview.tsx`, corresponding CSS and routes.

- [x] Upgrade homepage Catalyst Today to max-three Event × Flow × Trend observations when saved context exists, preserving fallback and future-only Tomorrow Map.
- [x] Add Flow Event Context and symbol links, plus a three-track symbol timeline with source, timestamp, cutoff and coverage labels.
- [x] Keep existing editorial visual style and verify desktop/mobile overflow, missing/partial states and historical navigation.

## Task 5 — Verification and rollout

- [x] Run targeted Vitest suites, TypeScript, changed-file ESLint and production build; check no signal/score/trading files changed.
- [ ] Commit only task files (exclude pre-existing `output/`), push main, deploy independent bundles and run data-only collection/analysis.
- [ ] Verify server health, saved context and public UI; confirm original Daily Review checksum and no message-sending test invocation.

Commands: `npm test -- tests/context*.test.ts tests/catalyst*.test.ts tests/option-flow*.test.ts`; `npm run typecheck`; `git diff --check`; `VERCEL=1 npm run build`.
