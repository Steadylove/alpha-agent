# Live V5 Scoring Implementation Plan

> **For agentic workers:** Execute the implementation and verification steps in this task. The root agent owns scoring, journal, rendering and images; a separate agent owns delivery-route regression tests.

**Goal:** New buy alerts use V5's sector-based five-factor score, frozen historical scores remain unchanged, and customer artwork explains the same live factors.

**Architecture:** Promote the existing V5 computation at `buildAlertView`, passing sector/date context from the journal. Persist the selected V5 score and its existing details together; replay the saved score and details. Keep V4 calculation explicitly named as the baseline used by V5 comparisons and historical tests. Separate preview labeling from the presence of V5 details.

**Tech Stack:** TypeScript, Next.js, Vitest, existing SVG/PNG card renderer, built-in ImageGen.

---

### Task 1: Reproduce the live-path mismatch

- [x] Extend `tests/signalDeliveryRoutes.test.ts` to inspect the view passed to the mocked renderer: both 2H and 4H must contain `quality-v5` with `板块共振`, no risk scoring dimension, and valid sector input must reach the score. Missing/stale sector data stays missing.
- [x] Add journal/default-view tests in `tests/signalAssessment.test.ts` for fresh V5 records, reference stop retained, no live `试算` label, no-ID and persistence-failure paths, frozen V4 replay and sell review.
- [x] Run `npm test -- tests/signalAssessment.test.ts tests/signalDeliveryRoutes.test.ts` and observe the old V4 expectation failures before implementation.

### Task 2: Promote the existing V5 computation

Files: `src/lib/signals/assessment.ts`, `candidateAssessment.ts`, `journal.ts`, `src/lib/discord/tvAlertCopy.ts`, `signalCardLayout.ts`.

- [x] Set the current version to `quality-v5`; give the preserved V4 computation explicit baseline names: `BASELINE_QUALITY_VERSION`, `BASELINE_QUALITY_WEIGHTS`, `baselineEntryQualityOf`. Update only its imports/call sites and legacy tests.
- [x] Extend `buildAlertView(p, label, rps?, fund?, context?: CandidateContext)`. For buys use `const candidate = candidateAssessmentOf(p, rps, context); const quality = candidate.quality;` and return both fields. Preserve buy/sell gates and reference stops.
- [x] Construct journal views with `{ ...candidateContext, asOf: rpsEvidence?.asOf, replay: false }`. Save `quality: view.quality` and `candidate: view.candidate`; on replay use frozen `saved.quality` and only use `saved.candidate` when the saved quality is V5. Do not rewrite existing records or substitute candidate V5 for historical V4.
- [x] Add `qualityPreview?: boolean` to `AlertView`; only `candidatePreviewView` sets it true. Use this flag for `试算`, while V5 details continue to control the details rows. Live `qualityPanel` uses `买点评分 · V5` and describes risk as independent.

### Task 3: Verify, document and produce customer artwork

- [x] Run targeted scoring, position, candidate, delivery, copy and snapshot tests, followed by `npm run typecheck` and lint on edited TypeScript. Run the full test suite if the default-view change passes focused tests.
- [x] Render a local V5 card without any outbound notification. Confirm five labels, stop separate, no preview badge, and readable layout.
- [x] Update `docs/signal-assessment-v5.md` to describe active scoring and historical preservation; mark V4 as the retained baseline.
- [x] Edit the user's supplied infographic using built-in ImageGen: `TREND-ADAPTIVE`, current five factors, sector diagram, updated position description, independent stop/risk guidance; no formulas or internal thresholds. Save under `output/imagegen/` and inspect the output.
- [ ] Verify available deployment access. Deploy only the concrete tested change through the configured route when possible under the user's switch authorization; otherwise report the exact deployment blocker and distinguish local completion from production status. Do not send sample notifications to customer channels.

## Verification results

- 776 tests passed using `npm test -- --maxWorkers=2 --testTimeout=15000`; the existing daily shell-job test exceeded the default 5-second timeout, with no assertion changes.
- Typecheck and edited-file ESLint passed. After the final English-brand-only card change, 47 affected tests, typecheck and focused lint passed again.
- Rendered the production OG path with clearly labeled synthetic data: all five V5 factors present, reference stop separate, no trial label; reviewed the customer infographic.
