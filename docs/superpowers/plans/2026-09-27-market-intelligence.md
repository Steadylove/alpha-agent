# Market Intelligence Implementation Plan

> **For agentic workers:** Execute the bounded tasks below in parallel by file ownership; integrate and verify before publication.

**Goal:** Replace Part 8's recap prompt with the investor's A–G cross-module analysis, grounded in saved primary facts and separately dated Event/Flow evidence.

**Architecture:** Keep original review and trading inputs immutable. Generate a versioned A–G output, retain legacy archive rendering, and attach raw same-date Context facts to the independent analyst evidence packet. Reuse existing collection and analysis schedules.

**Tech Stack:** TypeScript, Zod, Next.js/React, Vitest, DeepSeek, existing systemd jobs.

---

### Task 1: Prompt and output contract
- [x] Update `src/lib/review/analysis/types.ts`, `prompt.ts`, `model.ts`: new `market-intelligence-v2` output contains `marketRead`, `evidenceMap`, `structureRead`, `systemRead`, `eventFlowContext`, `synthesis`, `validationPoints`.
- [x] Preserve old archive parsing; require new format for new model responses. Require existing fact references and preserve missingness, provenance, comparable windows and the unique authority of Trend Adaptive.
- [x] Verify with `npx vitest run tests/reviewAnalysisModel.test.ts` including legacy reads, new generation, unknown references and optional Context coverage.

### Task 2: Evidence and lifecycle
- [x] Add `src/lib/review/analysis/contextEvidence.ts`: convert at most three same-date Context observations into bounded raw facts, preserving publication/relay/first-capture/version times, partial coverage and signal-knowledge flags. Never reuse AI summaries as evidence.
- [x] Extend `fingerprint.ts`, `service.ts`, `src/lib/review/store.ts` so auxiliary evidence is hashed, original seven-module hashes remain compatible, source changes during generation reject publication, and unavailable historical dates never use current data.
- [x] Extend `tests/reviewAnalysisService.test.ts` and add `tests/reviewAnalysisContext.test.ts`: missing, wrong-date, future and later supplementary evidence; cache invalidation; original bytes unchanged; old archive compatibility.
- [x] After scheduled Catalyst collection/analysis, independently run only `review:analysis` to incorporate its saved Context, preserving existing locks and schedules.

### Task 3: Part 8 presentation
- [x] Update `AnalystNote.tsx` and its existing CSS: render A–G in order with evidence links and meaningful missing states; preserve legacy layout for old archives. Update only Part 8's heading/subtitle in `DailyReview.tsx`.
- [x] Verify `tests/reviewAnalysisUi.test.ts` covers both output formats and ordered new sections.

### Task 4: Integration and delivery
- [x] Run `npx vitest run tests/reviewAnalysis*.test.ts tests/contextBackend.test.ts`, `npm run typecheck`, changed-file ESLint and a production build.
- [x] Review the diff for any unintended changes to original strategy, review, notification or position logic; update `docs/daily-review-analysis.md`.
- [ ] Publish the tested code and regenerate only the independent analyst output; confirm old review bytes unchanged, saved A–G output, deployed page and mobile layout.

Validation before publication: 112 tests passed; TypeScript, changed-file ESLint and production build passed. Build retains existing Next.js tracing warnings unrelated to Part 8. Independent review corrected the scheduled failure boundary so auxiliary AI failure does not suppress Part 8.
