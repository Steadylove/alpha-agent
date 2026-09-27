# Concise Market Intelligence

**Goal:** Make Part 8 explain the day's key change, incomplete confirmations and implications for the system in two connected paragraphs, with expandable evidence.

**Scope:** Version only the analyst output and prompt. Keep original review facts, evidence construction, strategy, schedules and publication safeguards unchanged. Preserve v1/v2 archives.

- [x] Add a v3 two-paragraph contract, concise relational prompt and validation; distinguish missing evidence from negative evidence and daily performance from durable cycle suitability.
- [x] Render v3 as prose with collapsed citations and metadata; retain archived layouts and visible stale/coverage status.
- [x] Run focused regression tests, typecheck, lint and build; document the output migration.
- [ ] Publish frontend before v3 generation, regenerate the latest saved analyst note, verify the underlying review checksum and desktop/mobile display.

Validation: 89 focused model, service, UI and evidence tests passed. TypeScript, changed-file ESLint and production build passed. The existing Next.js tracing warning is unrelated to this change.

Live prose review: v3.0 fit two paragraphs but still over-repeated numeric facts and tangential missing fields. Tighten the writing prompt to v3.1 so cited facts carry detailed numbers while prose explains relationships, incomplete confirmations and system meaning.
