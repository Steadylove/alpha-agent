# Catalyst Monitor

Independent `/catalyst` page and data-only VPS job. It reads model holdings, captured signals and Opportunity snapshots; it does not modify strategy parameters, scores, orders, positions, original review output or message deliveries. Page requests read saved JSON only.

## What is collected

| Source | Coverage | Configuration / limits |
| --- | --- | --- |
| Alpaca News | Recent company news and announced corporate events | Existing `ALPACA_API_KEY` / `ALPACA_API_SECRET`; last 7 days, 15-minute delay, highest-priority 100 symbols, at most 5 pages per run |
| BLS | Official economic release schedule | Public ICS; failures remain visible |
| BEA | Official release schedule | Public calendar; date-unknown items excluded with partial coverage |
| Federal Reserve | FOMC meeting dates | Official calendar; no invented announcement clock time |
| FMP | Scheduled earnings for observed stocks | Optional `FMP_API_KEY`; account entitlement required; scheduled dates/times may change |
| SEC | Recent company filing notices | Optional real `SEC_USER_AGENT` contact identity; first 10 priority symbols; filing text is not inferred from form type |

This is bounded coverage, not an exhaustive financial newswire, FDA database, investor-conference calendar or lock-up calendar. A disabled/failed source is never described as “no events.” Headline categories and importance are deterministic subject labels, not direction or trading confidence. Source links expose the original evidence. Scheduled items stay scheduled after their planned date until an actual published source is collected.

## Associations and research values

- Priority: 2H/4H **model** holdings → real captured signals from the last 10 calendar days → at most 100 Opportunity candidates/elite/high-RPS50 stocks → sectors → market. Maximum 200 observed symbols. Model holdings are not brokerage holdings.
- First-seen time and first-observed associations freeze. Current associations refresh. A historical backfill is labelled; it does not prove the event was known or the stock was held when it occurred. Events expire from the current view after 45 calendar days. Snapshot history retains the latest two immutable editions per UTC date for the most recent 45 dates including the current generation date (at most 90 regular archived snapshots); intermediate editions and older generated snapshots are pruned. `latest.json` is separate and never deleted by retention.
- Sources have independent health states and observation timestamps. Revisions preserve stable provider IDs. Only identical headlines for the same date, publication/event timestamps, time precision, symbols, type and status are combined with provenance links; there is no semantic/fuzzy merge.
- T0 is the first regular close after a confirmed publication time. After-close/weekend/holiday items move to the next actual exchange session; official close times cover shortened sessions. If time or calendar is missing, price windows stay unavailable.
- Baseline is the **previous regular close**, not an invented quote at the announcement minute. Intraday T0 includes pre-announcement movement, so the daily-window change is not an immediate or causal event return. T+1/3/5 use exact exchange dates; missing bars are never skipped forward.
- MFE/MAE cover T+1 through the matured portion of T+5, excluding T0. They are research excursions against the same close baseline, not achieved trade P&L.
- Daily RPS is reconstructed using the same 21/63/126/252 composite and that day's SP500 percentile scale on both sides. Under 450 samples, malformed or missing scales stay blank. This is not Opportunity RPS50. Before = baseline day; after = latest mature day through T+5.
- Sector comparison is the same ETF's 20-session return minus SPY's return, in **percentage points**, on both sides. It is not sector RPS. Unknown classification stays unknown.
- Reactions use existing daily CSVs. Alpaca updates default to `all` adjustment (splits and dividends); legacy fallback/incremental data can have source or adjustment discontinuities. Treat these values as labelled observational research; archives allow comparing revisions.

## AI summary

DeepSeek receives at most 10 selected events plus verified daily observations and coverage status. A versioned prompt produces 2–3 short Chinese sentences, each citing real event IDs. It must distinguish scheduled/published events, not predict returns or recommend trades, and cannot fill missing numbers. Every returned claim and citation is validated; if the provider returns more than three complete candidates, only the first three are published. Invalid/truncated responses or unknown citations are rejected. Failure leaves event data intact. Source text is untrusted input; keys and raw provider errors never enter public snapshots.

Use `DEEPSEEK_CATALYST_API_KEY`, falling back to `DEEPSEEK_REVIEW_API_KEY`, then `DEEPSEEK_API_KEY`. Model: `DEEPSEEK_CATALYST_MODEL`, falling back to review model, then `deepseek-v4-pro`. Input hashes reuse an unchanged valid summary; changed evidence marks the old summary stale until another analysis run. This module never calls the model from a browser request.

## Running

Run against local VPS data with `MARKET_DATA_DIR=/var/lib/alpha-agent/market`, `SIGNAL_JOURNAL_DIR=/var/lib/alpha-agent/desk`, `LIVE_BOOKS_PATH=/var/lib/alpha-agent/desk/live-books.json`, empty `MARKET_DATA_BASE_URL`, and unset `VERCEL`. The independent cron script sets these paths explicitly so 2H/4H model holdings come from the deployed live-book archive, not the repository's default `data/desk` directory.

```sh
npm run catalyst:build -- --dry-run
npm run catalyst:build
npm run catalyst:build -- --analyze
npm run catalyst:bundle
```

Dry-run checks configuration/file presence only: no source fetches, model calls, lock, or file writes. Real runs use a PID lock. Validated full results are archived first, then atomically published to `snapshots/catalyst/latest.json`. Retention runs only after successful publication and only removes generated timestamp/hash JSON files in this module's dated `history` directories; unrelated names, directories and symbolic links are not traversed or removed. Cleanup failure reports a failed job while leaving the newly published `latest.json` intact. A corrupt prior archive or publication write failure causes an explicit failed run instead of silently discarding the history. The separate `.catalyst/calendar.json` cache does not modify existing strategy data.

Install `deploy/market-http/cron/install-catalyst.sh` on the existing VPS after deploying the bundle. It installs two independent jobs: collection every hour at **:07 and :37** (every 30 minutes), and saved AI analysis daily at **08:55 Asia/Shanghai**. Collection is offset from the existing daily and macro jobs at :30 so it cannot win their simultaneous non-blocking lock attempt; its 10-minute service timeout plus timer accuracy leaves time before those scheduled jobs. A shared daily-job lock prevents reads while the main data update is writing. Collection skips a busy lock; analysis waits up to 30 minutes, then reports failure. No original daily cron or message sender is invoked.

```sh
systemctl start alpha-catalyst.service
systemctl start alpha-catalyst-analysis.service
systemctl status alpha-catalyst.timer alpha-catalyst-analysis.timer
journalctl -u alpha-catalyst.service -u alpha-catalyst-analysis.service -n 30
```

Secrets belong in `/var/lib/alpha-agent/daily-quant.env` (mode 600), never in browser environment variables, public archives or Git. Check source health on the page and service exit state after installation. A snapshot over two hours old is visibly labelled stale.
