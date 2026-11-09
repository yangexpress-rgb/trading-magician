# ADR 0063: 5-minute back tests, with bars that follow the conditions

- **Status:** accepted
- **Date:** 2026-11-09
- **Design refs:** §7.1, §20 #5; design v1.2 rows N178 and N179, open point O132. Builds on
  ADR 0052 (Alpaca request budget)

## Context

Back tests ran on daily bars (up to 5 years) or hourly bars (up to 1 year). Yong asked on
9 November 2026 for a 5-minute option, and for the Bars choice to default to 5 minutes when the
strategy's conditions read minute bars: "the back test data selection rules should try to match
the strategy condition specification". Alpaca's free IEX feed already serves 5-minute bars (the
Research chart uses them), and the demo history generates them.

A 5-minute series is twelve times the bars of an hourly one. Each Alpaca bars request returns up
to 10,000 bars; with pre- and after-market prints a trading day has up to 192. A Selection group
over the S&P 500 loads about 500 series one after another, so an uncapped 5-minute run could send
thousands of requests and use the key's whole 200 a minute, starving paper strategies on the same
key.

## Decision

- **5 minutes is a third run interval (N178).** `BACKTEST_INTERVALS` is `1d`, `1h`, `5m`. The
  engine, fills and metrics already work on any bar size; the assumptions and run summary name
  "5-minute bars".
- **A 5-minute run covers at most 31 days (O132).** That is about 1,700 regular-session bars per
  instrument, the same as a year of hourly bars (today's largest run in memory), and one Alpaca
  page per instrument.
- **A 5-minute run's bars load as background work.** The worker builds that run's routed history
  with `background: true`, which reaches the Alpaca client, so its requests wait within the key's
  budget (ADR 0052: at most 60 a minute of background work, 80 a minute always left free). An
  S&P 500 run takes about nine minutes to load; a single-stock run a few seconds. Daily and hourly
  runs are unchanged.
- **The Bars choice starts at the rules' interval (N179).** `matchingBacktestInterval` reads every
  series the rules use ("this instrument" included): anything shorter than an hour runs on 5-minute
  bars, hourly or 4-hour on hourly bars, the rest daily. The form follows edits to the rules until
  the person picks Bars; picking an interval whose cap is shorter than the dates moves the start
  up. When the chosen bars are coarser than the conditions, the hint says so.

## Consequences

- Conditions on 1-, 15- or 30-minute bars still have no feed that serves those sizes; their run
  steps on 5-minute bars, but the condition series itself needs a feed that serves its size.
- The 31-day cap can be raised later; the trade-off is load time and worker memory (O132).
- The API's default interval for a request that leaves it out stays daily.
