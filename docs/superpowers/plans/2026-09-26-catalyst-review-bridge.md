# Catalyst Review Bridge Implementation Plan

> **For agentic workers:** Execute the following bounded tasks in parallel where file ownership permits; review and verify the integrated result before release.

**Goal:** Add up to three Catalyst Today items to Daily Review and a concise, relevant scheduled-event list to Tomorrow Map.

**Architecture:** The independent Catalyst collector publishes a small, date-keyed supplement under `snapshots/catalyst/review/`. It reads an existing matching daily review without modifying it. The supplement records its own collection timestamp and is explicitly a post-review supplement, not evidence available at the original review publication. Pages only read the supplement; no provider or model calls occur during rendering. Published supplements are frozen; missing archives remain missing.

**Tech Stack:** Existing Next.js / TypeScript / Zod / Vitest / systemd pipeline.

---

### Task 1: Pure digest selection and validation

Files: `src/lib/catalyst/reviewDigest.ts`, `tests/catalystReviewDigest.test.ts`.

- [x] Define `CatalystReviewDigest`, `CatalystBriefItem`, and `CatalystReviewView` plus a validated parser.
- [x] Implement `buildCatalystReviewDigest(report, review)` from the complete report, never the website projection. Match the report's settled date to the review date, enforce collected/future time boundaries, and label the independent capture time.
- [x] Select up to three daily items: material published events on the review's ET date, with at most one relevant upcoming calendar item. Priority is Portfolio, Signal, Sector, Market; Opportunity-only is excluded. Deduplicate repeated object/type headlines.
- [x] Select at most three material scheduled events within `(capturedAt, capturedAt + 72 hours]`. Include the first 24 hours. Minute times are exact; date/session-only schedules retain their precision and cannot become invented clock times.
- [x] Price uses only a ready T0 observation on the review date. RPS uses comparable before/after observations ending on that date. Sector RPS comes from the matching review sector's real `d1`, never ETF excess-return data.
- [x] Test ET boundaries, future reaction exclusion, after-close pending prices, cancelled/estimated schedules, relation freshness, selection limits, stable ranking, missing sources, and no mutation.

### Task 2: Independent snapshot publication and reading

Files: `src/lib/catalyst/reviewDigestStore.ts`, `src/lib/catalyst/build.ts`, `src/lib/review/store.ts`, `tests/catalystReviewDigestStore.test.ts`.

- [x] Publish `catalyst/review/YYYY-MM-DD.json` only after the matching review exists. Freeze valid published results. If no useful evidence exists and required sources failed, defer publication so a later successful collection can retry.
- [x] Retain supplements independently of the full Catalyst 45-day archive. Do not rewrite daily-review JSON, original Tomorrow Map, AI evidence hashes, or delivery records.
- [x] Read the sidecar with its own timeout/failure boundary alongside the existing journal/analysis reads. Reject mismatched dates and future capture timestamps. Do not fall back to latest or silently reconstruct missing historical supplements.
- [x] Test immutable repeats, date mismatch, original review unchanged, missing/unavailable separation, retry after unavailable evidence, and remote reads without local fallback.

### Task 3: Compact user interface

Files: `src/components/review/CatalystBrief.tsx`, `src/components/review/catalystBrief.module.css`, `src/components/review/DailyReview.tsx`, `src/components/review/TomorrowMap.tsx`, `tests/catalystReviewBriefUi.test.ts`.

- [x] Add a compact Catalyst Today strip after market state and an anchor; keep the original section numbering.
- [x] Add Tomorrow Events as a separate concise list inside Tomorrow Map. Only subject, title, date/time and relation are shown, with a link to Catalyst Monitor. Do not repeat article summaries or change the original five watch events.
- [x] Distinguish `No Material Catalyst` in the observed complete source scope from missing/unavailable/partial coverage. Never imply market-wide absence.
- [x] Expose the supplement's ET capture time, collection-after-review label, price basis, and archive context without verbose duplicated news.
- [x] Verify static rendering, link escaping, numeric missing/zero values, mobile wrapping and 44px touch targets.

### Task 4: Verify and release

- [x] Run `npx vitest run tests/catalystReview*.test.ts tests/catalystBuild.test.ts tests/catalystCron.test.ts tests/dailyReview.test.ts tests/tomorrowMap.test.ts tests/reviewAnalysisService.test.ts`.
- [x] Run changed-file ESLint, `npm run typecheck`, `git diff --check`, and `VERCEL=1 npm run build`.
- [ ] Build only the Catalyst worker bundle, seed the new supplement without invoking any trading or notification job, and verify desktop/mobile pages with real saved data.
- [ ] Commit and push the scoped changes, update the independent VPS worker, and verify the production commit, page and timers.

Verification: 79 initial integration/regression checks passed; the final digest/store/UI suite passed 57 checks. Independent Chrome desktop (1440px) and mobile (390px) checks verified three real-data cards, disclosure interaction, source-page navigation, no horizontal overflow, no browser errors, and separate partial-coverage wording. The Friday-to-Monday pre-market boundary and CEO-comment filtering have explicit regression coverage.

Final production-mode build and 742.2 KB independent Catalyst worker bundle completed successfully before release. The existing daily strategy and notification jobs were not invoked during verification.
