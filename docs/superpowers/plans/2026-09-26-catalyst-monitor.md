# Catalyst Monitor Implementation Plan

> Agentic execution: independent provider, universe and UI workstreams share the explicit types below; root integrates storage, reactions, AI and operations. No strategy or signal-score mutations.

**Goal:** Publish an independent `/catalyst` observation module with sourced events, relevant-object links, daily reaction measurements and saved DeepSeek commentary.

**Architecture:** A VPS collector reads authoritative calendars and available company news, merges revisions without overwriting first observation, attaches current and first-observed universe relations, and writes versioned snapshots. The website reads saved JSON only. Deterministic code calculates daily price-window changes and comparable RPS; a bounded AI request explains cited events without predicting or trading.

**Tech Stack:** Existing Next.js/React, TypeScript, Zod, Vitest, VPS JSON snapshots and systemd timers.

## Boundaries

- Preserve all existing strategy, scoring, signal journal, model-account and review behavior.
- Initial calendar coverage: BLS, BEA, FOMC; company news: Alpaca, SEC filings; optional FMP earnings calendar. Failed/disabled sources remain visible.
- Store publication, planned occurrence, first discovery and revision times separately. Missing clock times stay unknown; scheduled events never become known results merely because their time passed.
- Reactions use previous regular-session close as an explicitly labelled daily-window baseline. Intraday news can include pre-announcement movement; no minute-immediate claim. After-close publication anchors to the next session. MFE/MAE exclude T0.
- Use only daily composite SP500 RPS on both ends. Sector comparison uses the same sector ETF 20-day excess return versus SPY on both ends, not another page's different RPS.
- First-observed object relations freeze; current relations refresh. Historical backfills are labelled. No invented historical holdings.
- Archive retention is bounded: after successful latest publication, retain at most two immutable snapshots per UTC date for the latest 45 dates including the generation date. Prune only standard generated JSON files under this module's dated history directories; latest, unexpected names, symlinks and other modules remain untouched. Cleanup failures surface as job failures while preserving latest.

## Tasks and ownership

- [x] Root: `src/lib/catalyst/types.ts`, `normalize.ts` — explicit event/universe/report contracts, strict archive validation, safe source URLs, deterministic identity/revision handling. Test deduplication, uncertain times, first-seen preservation and failures.
- [x] Provider workstream: `src/lib/catalyst/providers.ts`, `tests/catalystProviders.test.ts` — bounded read-only source fetchers, official calendar parsers, news/filing adapters, source health; fixture tests only.
- [x] Universe workstream: `src/lib/catalyst/universe.ts`, `tests/catalystUniverse.test.ts` — read model books, true signal archive, Opportunity and sector definitions; explicit timestamps and stable object IDs; degrade independently.
- [x] Root: `src/lib/catalyst/reaction.ts`, `tests/catalystReaction.test.ts` — real-session T0/T1/T3/T5, previous-close baseline, explicitly labelled existing adjusted daily panels, pending/missing separation, historical RPS, post-T0 extremes and signal timeline.
- [x] Root: `src/lib/catalyst/store.ts`, `build.ts`, `summary.ts`, `scripts/build-catalyst.ts`, `tests/catalystBuild.test.ts` — locking, bounded retention, immutable run snapshots, atomic latest publication, idempotence, independently failing sources, cited AI summary cached on evidence hash. Only CLI collects/generates.
- [x] UI workstream: `src/app/catalyst/page.tsx`, `src/components/catalyst/CatalystMonitor.tsx`, `catalyst.module.css`, `src/components/SiteNav.tsx`, `tests/catalystUi.test.ts` — responsive independent page, 72h calendar, relevant recent events, reaction table, universe/category/importance/range filters, evidence links and freshness states. No mock production data.
- [x] Root: `package.json`, `.env.example`, `deploy/market-http/cron/alpha-catalyst*`, `docs/catalyst-monitor.md` — standalone collector/service schedule and documented manual generation. Do not execute existing message-delivery jobs.
- [x] Integration: run catalyst fixtures plus existing review/strategy regressions, lint touched files, typecheck, production build, local HTTP/mobile rendering where tools allow. Probe live provider access without exposing credentials. Seed a real snapshot, verify source health and source URLs, deploy the isolated job/page and verify public HTTP.

## Verification commands

```sh
npx vitest run tests/catalystProviders.test.ts tests/catalystUniverse.test.ts tests/catalystReaction.test.ts tests/catalystBuild.test.ts tests/catalystUi.test.ts
npm run typecheck
npm run build
npm run catalyst:build -- --dry-run
```

Acceptance: no missing source represented as no events; no future observation used as before-state; exact-date outcomes do not skip gaps; failed model requests preserve successful event data; page refresh never calls a model; original score and strategy tests pass.

## Verification record

- 113 Catalyst tests passed; 60 existing model-book/review regression tests passed.
- Changed-file ESLint, repository typecheck and diff whitespace validation passed.
- `VERCEL=1 npm run build` passed (standard production mode; local live RPS regeneration needs Alpaca credentials and is outside this module).
- Real VPS seed loaded company news, BEA/FOMC schedules and daily reaction values. BLS returned 403; FMP and SEC lack configuration and remain visibly unavailable/disabled.
- Independent Chrome desktop/mobile smoke: events expand 12→24, changing filters resets to 12, no horizontal mobile overflow and no browser errors.
- Release verification: Vercel deployed the module; both independent systemd timers enabled. Real snapshot contains 279 events, 2H/4H holdings are connected, and DeepSeek commentary passed validation. Public HTTP and saved-summary checks passed. Next collection: 2026-09-26 15:30 CST; next scheduled analysis: 2026-09-27 08:55 CST.
