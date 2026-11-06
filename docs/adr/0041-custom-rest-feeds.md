# ADR 0041: Custom REST (JSON) market-data feeds

- **Status:** accepted
- **Date:** 2026-11-06
- **Design refs:** §9.2, §9.4, §15.4, §16.1; design v1.2 rows N17 to N23; refines ADRs 0015, 0016, 0038

## Context

§9.2 promises that people can add, edit, test, turn on and off, and remove a feed. Until now the
provider list was Demo, Alpaca and SEC EDGAR, each with its own adapter, so the promise held only
for those three. Yong asked for a provider type that lets a person describe any JSON price API in
Settings, with no code change per vendor and no vendor-specific code at all.

## Decision

- **A description, not an adapter.** Provider `custom_rest` ("Custom REST (JSON)") is one generic
  adapter driven by a stored description (`CustomRestConfig`, in `data_feed_connection.config`,
  migration 0053): an `https://` base URL; sign-in by none, API key in a header, API key in a query
  parameter, or bearer token; a daily-bars URL template and a latest-quote URL template with
  `{symbol}`, `{from}`, `{to}` (New York dates) and `{apikey}`; JSON paths for the bar fields and
  the quote fields; and limits. Paths are keys joined by dots, `[]` once for the list of bars and
  `[n]` for one item (`data.bars[].close`, `results[0].price`). Bar dates are ISO dates or
  date-times (the date is taken as the provider writes it) or Unix seconds (their UTC date). Numbers
  may be JSON numbers or numeric strings. US stocks and ETFs only. Checking, URL filling and mapping
  are pure functions in `@tm/domain` (`custom-rest.ts`), shared by the web app and the worker.
- **The key goes only to the feed's own host.** Both templates must start with the base URL, the
  key is placed only where the description says, and `{apikey}` is allowed only for query-parameter
  sign-in. The key itself is a `custom_rest` credential sealed like every other (ADR 0015): typed
  once into a password field, sealed on the server when the person first presses Test, never
  returned, logged or kept in the browser. Shown URLs and every error have the key replaced by
  `••••`. A key typed for a feed that is then cancelled is deleted.
- **No private networks.** The base URL must be `https` on port 443 with a public host name: IP
  literals, single-label names, `localhost` and local suffixes are refused when the description is
  checked. The worker checks again after DNS resolution and refuses any loopback, private,
  link-local, shared, documentation or multicast address (IPv4 and IPv6, including IPv4-mapped),
  so a public name that points inside a network is refused at connect time. Redirects are not
  followed, answers over 5 MB are dropped, and each connection is fresh.
- **Test before saving.** "Test" queues a `custom_feed_test` (migration 0054) with the checked
  description, the key reference and a symbol (SPY by default); the worker fetches about a month of
  daily bars and the latest quote, maps them, and stores either what it read (bar count, dates, the
  last five bars, the quote, the masked URLs) or the exact failure ("Daily bars: host answered HTTP
  401 (the key was refused…)", "Bar 1: the answer has no “close” (it has …)"). A custom feed can be
  saved only with a test that succeeded within the hour for the same description and key, matched by
  a SHA-256 of the canonical description and the key's id; changing the settings of a saved feed
  needs a new test, renaming it does not. Tests are limited to 10 a minute per person and deleted
  after a day.
- **It joins routing like any feed.** Adding it creates or backs up routes for bars and live prices
  as any price feed does (ADR 0038); it is checked every minute while on (the latest quote of its
  health-check symbol, through its limits), its quotes fail over after the 60-second stale rule and
  back after 5 minutes healthy, and both switches are audited and notified (ADR 0016). A quote with
  no mapped time counts as fetched now. It gives daily bars only; it does not look up, search,
  list or screen instruments, so those still come from Alpaca.
- **Bars fall back too.** A bars route now uses its fallback when the primary cannot answer (it is
  unreachable, over its limit, or lacks the interval, like a daily-only feed asked for hourly bars),
  for every provider. The series names the backup and the reason in its warnings, so a back test
  records which data it used. Bars routes keep no failed-over state; each request tries the primary
  first.
- **Fetched on the server, cached in the database, limited per feed.** Only the worker calls a
  custom feed. Answers are cached in `custom_feed_cache` (bars per symbol and date range: 12 hours
  for ranges that have ended, 15 minutes for ranges reaching today; quotes 15 seconds), shared by
  every worker and deleted with the feed. Every request is counted in `custom_feed_usage` per minute
  (and per UTC day when a daily limit is set) before it is sent; a request over the limit is not
  sent, and the caller hears "Held back: its limit of N requests a minute is used up". The person
  enters the provider's documented limit; the app's limit starts at 30 a minute and can be lowered,
  never raised above the documented limit or 300. The timeout is 1 to 10 seconds a request (5 by
  default). Bars are used as the provider gives them: the app's split and dividend setting is not
  applied, and the series says so.
- **Private to its owner.** Feeds, tests, cache and counters are tenant-isolated with row-level
  security like every other table; a person can only test with their own keys. The form says:
  "You are responsible for your provider's terms — most free tiers do not allow showing their data
  to other users." No licence checking is built.
- **A fake for tests.** `custom-rest-fake.ts` is a made-up JSON API (`prices.example.test`, token
  in a query parameter) used by the integration tests and, with `CUSTOM_REST_FAKE=true`, by local
  runs; production refuses the flag outside E2E. It is shaped like no particular vendor.

## Consequences

- Any JSON API with a daily-bars endpoint and a latest-price endpoint can be added without a code
  change. APIs that key bars by date in an object (rather than a list), need two key headers, use
  milliseconds, paginate bars, or put the date range in another form need a later extension of the
  description, still without vendor code.
- A health check every minute is about 1,440 requests a day, more than many free tiers allow; a
  daily limit makes the feed hold back (and go down) instead of being cut off by the provider.
- Options, fundamentals, streaming feeds and file-based feeds (such as the CBOE VIX CSV) are not
  covered.
- The cloud build environment cannot reach outside APIs, so the adapter is tested against the
  fake; the check against a real free API is run from a deployment.
