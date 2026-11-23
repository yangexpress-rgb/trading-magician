# ADR 0114: One shared price request per feed, named price failures, and price incidents that close themselves

- **Status:** accepted
- **Date:** 2026-11-23
- **Design refs:** design v1.3 §12.4, §15.2; N328; O210, O211. Yong's brief "Live price feed drops
  symbols after the open; incidents never close themselves" (2026-11-23). Builds on ADR 0087
  (batched quotes), ADR 0096 (N276 quiet quotes) and ADR 0097 (automatic resume).

## Context

On Monday 2026-11-23 from 9:32 ET, strategies on staging reported "Stale prices … SPY (no price)"
and "Live prices lost" for SPY, QQQ, SVXY and UVXY while NOW and FICO orders filled. 197 "Prices
are stale" notices arrived between 9:45 and 9:54 ET.

There is no stream: each runtime pass asks Alpaca's REST snapshot endpoint for its own prices. The
worker logs showed Alpaca answering 429 "over its request limit for this key" at 9:39, 9:46 and
9:50 to 9:53 ET for the shared admin key every run uses. 18 runs passing every 5 s ask about 216
times a minute before orders, bars, back tests and the watch list; Alpaca's free plan allows 200.
The 8 VIX strategies started on 2026-11-18 took the count from 10 to 18. A refused or timed-out
ask was swallowed and became "no price". Each pass that was clean resolved the incident and the
next refused pass opened a new one, so each flicker was a new notification.

## Decision

- **Shared prices.** `QuoteHub` (`apps/worker/src/quote-hub.ts`, held in `RuntimeCaches.quotes`)
  is the one place runtimes get live prices from. A feed is asked at most once per 2 s, for every
  symbol any runtime asked for in the last 30 s, in as few requests as the feed allows; each runtime
  reads its prices from what came back. Failures are kept for the same 2 s, so a refused key is not
  asked again at once. After a failure the next request carries the whole wanted set, and its
  recovery is logged (`quotes.feed_restored`, with `restored` and `stillMissing`). The collar's read
  at release (ADR 0113, `askFresh`) still goes straight to the feed.
- **Named failures.** An ask without a price carries why: `throttled` (Alpaca 429), `timeout`,
  `error`, or `no_reply` (the feed answered without the symbol). The price incident says which,
  e.g. "Alpaca refused the price requests for SPY, QQQ as over the key's request limit; no new
  orders are sent until they are current." The guard is unchanged: missing or stale prices still
  refuse orders, and 60 s of them still pause the strategy.
- **Subscribed but silent.** A symbol the feed is answering for, while other prices move, with no
  new trade or quote for longer than the threshold in the regular session, is reported on its own:
  "Subscribed but silent: the feed is answering but sent no new price for SVXY for 75 seconds;
  other prices are current, so orders still go." It is a `stale_data` incident with
  `details.state = 'silent'`, shown as "Silent prices"; it neither refuses orders (N276 stands)
  nor notifies (O210). A symbol the feed answered without is silent too, and does refuse orders.
- **Self-closing incidents.** A runtime's price incident stays open until its prices have been
  current for 30 s (`FEED_CLEAR_MS`), then closes itself with "Closed on its own after 3 min 12 s"
  and `details.durationSec`. While open, its wording follows the prices. Orders shows "Closes on its
  own" instead of "Mark resolved" for price incidents, and lists those closed in the last 4 hours
  with how long each lasted.
- **One notice per outage.** A price outage is told when the first runtime's prices go bad while
  no other runtime's are, and when the last runtime's prices are current again ("Prices are
  current again … after 4 min 10 s"). The lost-prices incident and its pauses are told once per
  outage, naming what it paused; the per-strategy "paused" notice is left to the Orders page
  (O211). The automatic resume after a feed outage is told when the last paused strategy resumes.
  A continuous outage therefore gives at most 4 notices, however many strategies and symbols it
  touches and however long it lasts: prices stale, prices lost (paused), resumed, prices current.
  An outage that clears for 30 s and returns is a new outage.
- **Logging.** PR #231's once-a-minute `alpaca.traffic` and `quotes.trail` lines, and
  `runtime.slow_pass`, stay.

## Consequences

- Price requests no longer grow with the number of strategies, only with how many distinct
  symbols they watch (one Alpaca request per 100 symbols every 2 s at most).
- Bars, order traffic, back tests and the watch list still share the same Alpaca key; if the
  traffic log shows the key still over 200 a minute, a second key or a paid plan is Yong's call.
- No migration: the silent state and duration live in `execution_incident.details`.
