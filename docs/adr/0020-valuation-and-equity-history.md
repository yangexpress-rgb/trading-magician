# ADR 0020: Valuation and daily equity history

- **Status:** accepted
- **Date:** 2026-10-05
- **Design refs:** §10, §10.2, §8.5, §15.3

## Context

The Performance tab needs an equity curve, drawdown and a time-weighted return, and §10.2 asks
for a defined valuation method. Replaying every fill and price for each chart would be slow and
would change history whenever a price feed changed its mind. Yong approved the Phase 5 defaults on
2026-10-05: marks from the tenant's routed feed with stale prices flagged, USD only, and any
position difference, or equity more than $1.00 apart, flagged with the broker as authoritative.

## Decision

- **Valuation.** Every account is valued every 5 minutes (`VALUATION_EVERY_SEC`). The worker claims
  due accounts through `claim_valuations` (a lease, like the other worker queues), rebuilds the
  account's ledger (ADR 0019) and marks open lots at the last price from the tenant's routes
  (ADR 0016).
- **Marks.** A price is stale when it is more than 60 s old, the paper stale-data limit, counting
  up to the session's close, so the closing price stays a good mark overnight. Stale or missing
  marks are still recorded (the last good price, or none) and counted on the valuation.
- **Equity** is starting equity plus realized net, plus unrealized, less fees already paid on what
  is still open. The demo account starts at $100,000, the same figure an Alpaca paper account starts
  with; this is a constant (`DEMO_STARTING_EQUITY`), not a §20 policy. Other accounts take their
  starting equity from the broker the first time it reports equity, less what the app had made or
  lost by then, so the two start level.
- **One row per session.** `account_valuation` and `book_valuation` (per strategy runtime, account
  and instrument) hold one row per NYSE session, rewritten during it. The first valuation from the
  4:00 pm New York close is final; a trigger stops anyone changing a final row. If the broker cannot
  be asked at the close, the row stays open and the next valuation tries again.
- **Broker comparison at the close.** The final valuation snapshots both sides' positions
  (`position_snapshot`, source `app` and `broker`) and flags any quantity that differs, or equity
  more than $1.00 apart. A flag sends one always-shown "reconciliation mismatch" notification per
  account and session. The broker's figures are the ones that count; nothing is paused, because the
  minute-by-minute reconciliation (ADR 0014) already pauses strategies on position mismatches.
- **The simulator** holds no cash, so a demo account is valued from the app's own ledger; only its
  positions are compared.

## Consequences

- Charts and returns read stored daily rows; they do not change when a feed later corrects a price.
- Positions bought or sold outside the app appear as position differences at the close, with both
  quantities, which the Performance tab shows under "Outside the app".
- A worker that is down over a close leaves that session without a final row until it returns the
  same evening; a session it misses entirely has no row, and charts carry the last value forward.
