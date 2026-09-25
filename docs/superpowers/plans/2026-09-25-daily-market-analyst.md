# Daily Market Analyst Implementation Plan

> **For agentic workers:** Implement the checked tasks below with bounded file ownership and regression checks.

**Goal:** Add an independent DeepSeek analyst after the daily review job; the website reads saved results without changing the existing seven modules or sending extra messages.

**Architecture:** Frozen review → deterministic evidence packet → one bounded DeepSeek JSON request → schema and evidence validation → atomic independent snapshot → optional eighth page section. Generation failures preserve existing results. Source fingerprints expose stale analysis after supplementary data changes. No autonomous tools, execution decisions, or strategy parameter changes.

**Tech Stack:** TypeScript, native fetch, Zod, atomic JSON snapshots, existing VPS Bash job, Next.js/React, Vitest.

## Work units

- [x] Define client-safe contracts in `src/lib/review/analysis/types.ts`.
- [x] Build bounded, dated evidence in `evidence.ts` with tests for missing/stale options, as-of journal outcomes, scoring versions, source dependencies and partial account attribution. Exclude core strategy rules and secrets.
- [x] Version a Chinese analyst prompt in `prompt.ts`; implement DeepSeek JSON generation and runtime validation in `model.ts`. Test invalid IDs, oversized output, missing keys, timeouts and provider errors. Preserve existing source state labels outside generated prose.
- [x] Add `service.ts` / `fingerprint.ts` and `scripts/build-review-analysis.ts`: require the expected exchange session by default, read local frozen data, hash inputs, skip identical successful results, reject source changes during generation, preserve successful snapshots on failure and release process lock.
- [x] Wire `review:analysis` into the existing VPS daily job after original delivery steps as a soft independent step, and into the manual GitHub daily path after original deliveries with a separate analysis-only upload. Test failure isolation with stubbed commands; never execute the real delivery job as a test.
- [x] Read optional analysis in `src/lib/review/store.ts` under its own catch. Validate date/version/citations and source fingerprint; no remote-to-local fallback and no model calls on page requests.
- [x] Add `AnalystNote.tsx` / styles and an eighth `DailyReview` section with saved date/model/state, concise note, optional observations, inspectable evidence, stale/missing states and retrospective generation time. Plain escaped text only.
- [x] Document configuration and invocation. Run targeted tests, typecheck, lint changed files and production compilation. Verify a real DeepSeek response if an existing key is configured, keeping credentials and model reasoning out of outputs.

## Acceptance

- Existing review schema, classifications, scores, journal and notifications are unchanged.
- Partial inputs are reported, never filled with invented data; signals retain their historical as-of window.
- Every generated claim references existing evidence. Structural validation does not claim to prove semantic correctness.
- Analysis failure or missing credentials do not block existing daily operations or overwrite successful analysis.
- Page load never invokes a paid model request; old-day results are never substituted for today's result.

## Deployment

Configure `DEEPSEEK_REVIEW_API_KEY` only on the daily worker; default model is `deepseek-v4-pro`, override with `DEEPSEEK_REVIEW_MODEL`. Run a data-only analysis command for initial publication, never the full push cron. Review the complete diff and validation results before any production write.

## Verification record

- New evidence, model, persistence and UI tests pass; original review/health/macro/desk and cron regressions checked.
- TypeScript, changed-file ESLint and production compilation passed.
- A real DeepSeek response from the 2026-09-24 archived review was validated and rendered by the local production page (HTTP 200, eight sections).
- Visual browser capture was unavailable in this session; no visual screenshot verification is claimed.
