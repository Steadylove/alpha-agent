# Catalyst coverage recovery and scheduling

## Goal

Fill the current site's verifiable source gaps and schedule collection and supplements without changing the trading strategy, sending trading alerts, or rebuilding historical reviews with future information.

## Verified causes

- Alpaca news stops at 100 symbols and five pages even when another page exists.
- The Opportunity observation list stops at 100 candidates; the latest source contains 106.
- The BLS official calendar returns HTTP 403. BEA has a genuinely undated release.
- FMP earnings is unconfigured; a public Nasdaq calendar is being verified as a clearly attributed, estimated alternative.
- SEC submissions require a real technical contact email, which has been requested from the user.
- The current 2H ledger epoch has no preceding month-end equity. The older epoch cannot be used to manufacture a monthly return.
- Published Daily Review Catalyst supplements freeze once nonempty; later recovered sources need an explicitly versioned supplement.

## Implementation

1. Cover the current observation pool with bounded complete news pagination. Preserve partial status for unfinished pagination, missing symbols and provider failures. Keep actual publication and capture timestamps.
2. Add verified public calendar fallbacks with honest attribution, date/session precision and coverage. Retain source failures and truly unknown dates as such.
3. Extend SEC collection across applicable observed stocks after valid contact configuration; preserve pacing and partial failures.
4. Explain unavailable monthly returns without changing accounting or using an incompatible baseline.
5. Add an explicit latest-review supplement refresh: validate new content, archive previous bytes, atomically publish the new revision, and display actual capture time. Default half-hour collection remains frozen.
6. Reuse existing systemd units: half-hour collection at :07/:37; analysis/supplement after the morning daily run, after the 12:30 macro refresh, and at 08:55 America/New_York on weekdays. Add bounded failure retries; preserve shared locks.

## Verification and delivery

- Test pagination beyond former limits, request budget exhaustion, aliases and source failure safety.
- Test calendar parsing with official fixtures, undated items and estimated sessions.
- Test supplement revisions, archival failures, old-date refusal and scoped completeness.
- Verify systemd schedules and bounded retries, run affected regression tests, typecheck, lint and production build.
- Commit and push scoped changes, install the collector bundle and units on the existing VPS, run collection/supplement only, and verify saved data and website.
- Report any still-unavailable upstream information rather than claiming complete coverage.
