# ADR 0017: Alpaca adapters and instrument lookups

- **Status:** accepted
- **Date:** 2026-10-05
- **Design refs:** §9.2, §9.3, §17.4, §20 #1–2

## Context

Alpaca is the first real provider (Phase 4 decision 1): one paper API key gives real-time US stock
and ETF prices from the free IEX feed and a paper broker. The adapters must pass the same
contract suites as the demo feed and simulated broker, CI must run without keys or network, and
nothing may ever reach a live trading endpoint.

## Decision

- **One package, `@tm/alpaca`.** A small REST client signs requests with the stored paper key,
  times out, and maps failures to three kinds: unreachable or throttled (retryable,
  `BrokerUnavailableError`), a refused key, and Alpaca's own request errors. Errors and logs never
  carry the key; the client serializes and inspects without it.
- **Paper only, by construction.** The client refuses any trading host but
  `paper-api.alpaca.markets`, and names `api.alpaca.markets` as refused. A local fake is allowed
  only with an explicit test flag. This sits beside the app-wide guard of ADR 0002.
- **Market data.** Live prices come from the IEX snapshot (last trade, best bid and ask, provider
  timestamp kept). Bars come from IEX daily and hourly bars with Alpaca's raw, split or all
  adjustments; daily bars are given the regular-session times, hourly bars follow clock hours
  clipped to the session (the first covers 9:30–10:00), and both caveats are shown as warnings.
  The data version is a digest of the returned bars. A feed check confirms the paper account is
  active and the data API accepts the key; IEX is included with every Alpaca account.
- **Broker.** One adapter per Alpaca paper account. Orders are placed with the app's idempotency
  key as `client_order_id`; a repeat is recognized from Alpaca's "must be unique" reply and
  answered with the original order. Order states come from the order list (changes newer than the
  cursor's watermark) and fills from the account's fill activities, each keyed by Alpaca's own id,
  so repeats are harmless. The cursor is opaque: the last fill read and the newest order change
  seen. Only the 500 most recent orders are scanned for state changes; reconciliation reads older
  orders directly. Orders outside Alpaca's rules (extended hours other than day limit, fractions,
  short sales on an account that cannot short) are refused before sending.
- **Capability discovery** reads the account (currency, status, whether it can short) and fills
  in Alpaca's documented order types and time-in-force values. Fractional orders and multi-leg
  atomic fills are not offered.
- **A fake Alpaca for tests and E2E.** `@tm/alpaca/testing` answers the same REST paths with the
  same JSON shapes, transcribed from Alpaca's API reference into `testing/fixtures`; a test checks
  the fake's responses carry exactly the fixtures' fields. Orders are worked by the built-in paper
  broker against the demo price paths, so the broker contract suite (with injected duplicates,
  reordering, lost replies and disconnects) and the new live-quote and history contract suites
  run against it. Its symbols are made up. The worker uses it only with `ALPACA_FAKE=true`, which
  production refuses outside E2E.
- **Instrument lookups.** A person asks for a symbol from the strategy editor. The web app can only
  read the shared instrument table, so it queues an `instrument_lookup`; the worker claims it,
  asks the provider behind the tenant's US stock route, and registers the instrument through
  `register_instrument`, which only the worker's `tm_secrets` role may call and which refuses the
  demo venue. Alpaca does not mark funds, so a name containing ETF, ETN, Fund or "Trust, Series"
  is taken as an ETF. The picker lists demo instruments plus those the tenant looked up or uses,
  so one tenant never sees another's lookups.
- **Bars follow routes too.** Back tests and running strategies get bars through the tenant's bars
  route, like prices (ADR 0016), so a real instrument uses its provider and demo instruments keep
  the generated history.

## Consequences

- Using Alpaca for orders needs a broker account in the app; Settings › Trading platforms adds that
  in M4.4, which is when a paper order can be placed and canceled with a real key end to end.
- The fake encodes our reading of Alpaca's documentation. The manual check with a real paper key
  is what confirms it; any difference becomes a fixture change and a failing test.
- The free IEX feed covers one exchange, so prices and volumes differ slightly from the whole
  market; a paid feed can be added later as another feed and route.
