# ADR 0039: No demo data in deployments

- **Status:** accepted
- **Date:** 2026-11-06
- **Design refs:** §9.2, §11, §21; changes ADR 0016, ADR 0018, ADR 0030

## Context

Until now every database was seeded with seven invented instruments (DEMO-A … DEMO-BND on the
DEMO venue), and every new workspace got a "Demo feed" that priced them with generated history
and a simulated live feed. The screener and Quantitative Research fell back to them without a
real feed, and the Free plan was defined as "demo feed only". Yong now uses real Alpaca paper and
SEC EDGAR feeds and asked for the demo instruments and demo stocks to be deleted.

## Decision

- **Demo data is off unless `DEMO_DATA=on`.** Only the automated tests set it (vitest through the
  database test harness, Playwright's servers, and the CI seed step), so they keep running with
  no provider. With it off:
  - `db:seed` inserts nothing (it still runs on every deploy and stays safe to repeat);
  - a new workspace gets no data feed, only the built-in paper account, and that account trades
    real US listings (`coverage: 'us'`) priced by the feed the person adds;
  - the demo provider is not offered in Settings › Data feeds, and the API refuses it;
  - the screener with no feed says to add an Alpaca feed instead of screening demo instruments,
    and the worker fails such a screen with the same message.
- **Migration 0051 removes existing demo data without touching anyone's own records.** It drops
  demo feeds and routes, cached demo charts, look-ups and screens, and every demo instrument no
  record uses, renames the default "Demo paper broker/account" and lets that account trade US
  listings. Anyone with a strategy, order or position on a demo instrument keeps their demo feed,
  routes, paper account coverage and those instruments, so nothing they made breaks; they can be
  removed by hand once that person agrees.
- **The Free plan may add its own market data.** With no demo feed Free would have no prices at
  all, so `liveData` is now on for Free: a Free user pastes their own Alpaca paper key. Free still
  trades only on the built-in paper account (`paperIntegrations` stays off).
- **The built-in paper broker stays.** It is the simulator from ADR 0018, not demo data; it now
  fills real US listings at the prices of the person's own feed. Its provider id stays `demo` so
  no stored rows change meaning.

## Consequences

- The demo provider code (generated history, simulated live feed) remains, as a test fixture.
- A person with no feed sees empty research pages and a notice to add an Alpaca feed.
- Back tests read bars from the person's own feed; the label says so.
