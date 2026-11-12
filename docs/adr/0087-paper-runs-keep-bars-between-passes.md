# ADR 0087: Paper runs keep bars between passes, so stock groups run on paper

- **Status:** accepted
- **Date:** 2026-11-12
- **Design refs:** design v1.2 N13 (settled), N245; open point O17 (closed). Builds on ADR 0040
  (Selection groups), ADR 0052 (per-key Alpaca request budget), ADR 0080 (built-in stock groups),
  ADR 0081 (back-test workload cap) and ADR 0084 (shared data feeds).

## Context

Selection groups over a built-in stock group (the S&P 500 and the others of ADR 0080) could be
back tested but not started on paper; lists were capped at 50 instruments (N13, O17). Yong hit
the refusal on 2026-11-12 with "Earnings breakout - S&P500" and chose to lift it.

The limit came from how the paper runtime read data. A running strategy gets a pass about every
second (`RUNTIME_POLL_MS`), and every pass:

- asked the feed for every series the rules read, from scratch, one request per series: about
  500 requests a pass for the S&P 500, against an Alpaca key allowed 200 a minute;
- asked for a live price for every instrument, members included;
- reloaded earnings, filings, options signals and model scores for every member;
- and could not look up a built-in group's members at all (only back tests resolved them).

A back test does not have the problem: it loads each series once and replays it.

## Decision

- **Bars stay loaded between passes** (`apps/worker/src/runtime-cache.ts`, `RuntimeBarCache`).
  The first pass loads each planned series; later passes are answered from memory until a bar of
  that size can have ended (`nextBarEnd`: clock multiples of the bar size inside the NYSE session,
  the close for daily bars), plus a grace (20 s intraday, 5 minutes daily). Then only the newest
  bar's day onwards is asked again and merged. A bar that should be in but isn't is asked again
  every 30 s for three minutes, then left (a stock without trades in a bar never gets one).
  Overnight and at weekends nothing is asked.
- **One request for many symbols.** `HistoricalDataProvider.getBarsMany` (optional) answers many
  series at once; Alpaca sends up to 100 symbols per `/v2/stocks/bars` request (a day of 5-minute
  bars for 100 symbols fits one page). A batch Alpaca refuses is retried one symbol at a time; a
  throttled or unreachable batch fails alike. The routed history sends each instrument's requests
  to its primary feed together and falls back per instrument as before. Feeds without the method
  (custom REST, demo) are asked one series at a time, still only when a bar is due.
- **Shared within one set of feeds.** Series are keyed by whose routes answer (the member, or the
  sharing admin, ADR 0084) and the series, so two strategies on the S&P 500 load it once. A series
  is kept back to the earliest date any runtime reading it still needs; series nobody has read for
  15 minutes are dropped. A series that fails is asked again after a minute, not every pass; a
  member whose bars fail is left out of the pass, as back tests leave it out.
- **Members are looked up once a day.** The runtime resolves a built-in group as back tests do
  (`resolveBuiltinUniverse`), once per person, group and New York date, keeping the last list for
  five minutes when a lookup fails.
- **Live prices only where the runtime trades.** The stale-price watch skips group members the
  runtime neither holds nor has a working order on. A new pick's price is still checked by the
  pre-trade risk check before its order goes out.
- **Other data for a minute.** Earnings, deals, filings, options signals and model scores are
  reloaded when a new bar arrives, when the members change, or after 60 seconds.
- **A memory cap replaces the size cap.** Start refuses a strategy whose bars would exceed
  `MAX_PAPER_BARS` = 400,000, saying what drives the size. The count is what the runtime keeps,
  not what it loads: each series keeps the bars its rules read back (offsets, indicator warm-up,
  metric look-backs) plus two sessions of bars, at least 5 (`paperBarsKept`); the plan's calendar margin (at least a week, for holidays and gaps) is
  only loaded, a chunk of 100 series at a time, and trimmed at once. The whole S&P 500 keeps about
  80,000 bars per 5-minute series kind, a few thousand on daily rules, and about 130,000 for a
  daily ranking by 12-month return. (First version, same day:
  the cap counted the load margin, about 235,000 bars per 5-minute series kind, and refused Yong's
  5-minute S&P 500 strategy at 478,856.)

- **Passes are spaced out, prices asked together** (added 2026-11-12, after an S&P 500 runtime
  paused on "the paper broker has not answered for 61 seconds"). Every pass asks the broker for
  updates (two Alpaca requests) and the feed for a price per watched instrument, and a pass came
  about every second: a runtime holding ten stocks sent about 700 requests a minute, while Alpaca
  allows 200 a minute per key, shared by trading and data. Throttled calls count as the broker not
  answering, so the runtime paused. Now a runtime's next pass waits `RUNTIME_PASS_EVERY_MS`
  (default 5 seconds; tests and E2E use 0), and each pass first asks for every watched instrument's
  price at once (`latestQuotes`: Alpaca `/v2/stocks/snapshots`, 100 symbols a request). A runtime
  now sends about 40 requests a minute.

## Consequences

- S&P 500 and other built-in groups, and lists of any length, start on paper. The Selection
  editor's "paper runs take lists of up to 50" note and the "back test only" validation warning are
  gone.
- A daily strategy over the S&P 500 sends a handful of requests at start and about five after
  each close. A 5-minute one sends about five every five minutes in the session. Both stay far
  inside the key's 200 a minute.
- Bars live in the worker's memory alongside back tests (ADR 0081's 1.2 million bar cap). A
  5-minute S&P 500 runtime holds about 100 to 200 MB. Several such runtimes plus a maximal back test
  could exhaust the 2 GB heap; if that shows up, the next step is a compact numeric bar store.
- Several workers each keep their own copy; a runtime that moves to another worker loads again
  once.
- When the clock jumps (tests), a series not read for 15 minutes of clock time is loaded afresh.
