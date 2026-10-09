# Event × Flow × Trend

This is a read-only observation layer around the existing trend system. It does not contribute to a score, change signal conditions, select trades, size positions or send messages.

## Reading the module

- **Event:** published external reports with source links, publication time, immutable first observation, current-version availability and bounded revision history.
- **Options Flow:** FL0WG0D reports relayed through Discord/OCR. This is a **Partial Market Sample**, not exchange-wide order flow. Source-reported Buy/Sell and Call/Put are preserved; missing side, strike, premium or expiration are not invented. Premium is not net inflow; neither institutional identity nor opening/closing can be established.
- **Trend:** existing live 2H/4H signal captures, current model holdings, and available composite daily SP500 RPS observations. A signal is not an executed trade. Current model holdings are neither the investor's brokerage account nor proof of event-time ownership.

Same-symbol evidence is associated over ±1 actual exchange session; a separately labelled ±3-session window provides research context. Publication/relay session anchors are separate from Catalyst's existing price-reaction T0. The matching window does not change trading rules. Coverage gaps and immature windows remain explicit. Co-occurrence does not establish causation.

The homepage shows at most three observations. `/context/[symbol]?date=YYYY-MM-DD` shows separate Event, Flow and Trend tracks. Flow Research links retain their archived date. Tomorrow Map continues to show only its existing relevant future 24–72 hour event summary; this module does not repeat the full news page.

### Homepage selection

The homepage selects from the complete saved observation set before reducing its payload. It requires a non-low-importance company event paired with a system signal in the same anchored session, or an existing short-window event/flow association within one exchange session. Market/sector stories, broad multi-company stories and headline roundups are excluded; holdings or RPS alone do not qualify. More evidence types, event versions known before the signal and high event importance receive editorial priority. This priority is not a trading score. Old archives without scope/symbol metadata remain readable and use their saved type, importance and headline.

Each selected ticker shows a rule-based Chinese topic/relationship description and an evidence timeline. The original headline, source and capture/version timestamps are available in a collapsed disclosure. Publication time and relay-message time are labelled separately; the latter is not a trade timestamp. Missing intraday precision remains unknown. Signal-time knowledge requires publication, first observation and current-version availability all to precede the signal.

Matched live buy signals also show existing Signal Journal T+1/T+3/T+5 price returns, capped at the selected review date. The match requires the same ticker, timeframe, signal time and an available capture; replay signals and sell signals do not inherit buy returns. Pending and missing outcomes stay explicit. This is individual outcome inspection, not a cohort backtest or proof that these associations improve returns. No qualifying association produces a compact empty state; source archives remain intact.

## Availability and revisions

Source publication, actual trade time, first system observation, evidence-version availability and report cutoff are different fields. Actual Flow trade time and original tweet publication time remain unknown unless independently supplied. Legacy Flow first capture is unknown; an old `postedAt` or overwritten `ingestedAt` is not evidence of availability. Later OCR or text revisions cannot be described as known at a previous signal.

Event and Flow retain the first evidence and four recent superseded versions, with an explicit truncation marker. Full Context snapshots freeze the displayed evidence independently. A per-poll `option-flow-health.json` records successful zero-result polls and sanitized failures. Poll success establishes only that retrieval attempt, not uninterrupted historical or full-market coverage.

`snapshots/context/latest.json` updates with the independent Catalyst collector. Date-keyed `snapshots/context/YYYY-MM-DD.json` is created only after the corresponding latest Daily Review exists and the exchange calendar confirms that settled date. It stays frozen on ordinary collection. The existing scheduled `--analyze --refresh-review-digest` run also explicitly refreshes the latest settled Context; prior exact bytes are first saved under `context/history/YYYY-MM-DD/`. Older review dates are not rewritten. Cutoff, generation time and revision distinguish editions. The original Daily Review JSON is never modified.

If AI is added later without an evidence refresh, the evidence cutoff remains frozen. Missing historical dates and remote read failures do not fall back to current or build-machine data. A corrupt old archive is preserved and publication reports failure. Missing Context never hides the original review.

## AI and operations

DeepSeek receives bounded same-symbol facts, coverage, timestamps and allowed evidence references. The prompt forbids causal claims, invented institutional motives, new scores, recommendations and unsupported numbers. References must belong to supplied facts for a single symbol; common unsupported causal/trading claims are rejected. Output is saved with model, generation time and evidence hash. A browser visit never invokes AI or news collection.

Configuration: `DEEPSEEK_CONTEXT_API_KEY` and `DEEPSEEK_CONTEXT_MODEL` are optional overrides; fallback is the existing Catalyst, then Review, then general DeepSeek key. The existing model default remains `deepseek-v4-pro`. Keys stay server-side and out of snapshots/Git.

The existing independent Catalyst collector runs at :07/:37 each hour. Saved analysis runs Tuesday–Saturday 10:05 Asia/Shanghai, daily 12:55 Asia/Shanghai, and Monday–Friday 08:55 America/New_York. Context shares these jobs and their existing locks/retry limits. The cron wrapper explicitly reads `/var/lib/alpha-agent/desk/option-flow.json`; it does not invoke the daily trading job or a message sender.

Validation: Context model tests cover exchange-session windows, missing/late/revised evidence and signal-time knowledge. Backend tests cover exact-byte archives, old-date isolation, strict remote reads, citation validation, model failure and unchanged original Review. UI tests cover max-three summaries, separate tracks, source escaping, fixed-date links and preserved Tomorrow behavior.
