# ADR 0108: Each account's own data feeds, with a fallback chain

- **Status:** accepted
- **Date:** 2026-11-23
- **Design refs:** design v1.3 §15.2 (data feeds), §12.5, §8.6, §16.3; N314, N315, N316; O185 to
  O189. Phase 7 brief §4 ("Data feeds per account"), build P2, started at Yong's OK on 2026-11-23.
  Builds on ADR 0016 and 0038 (routes and their failover) and ADR 0106 (a run is one strategy on
  one account).

## Context

Every run priced from the tenant's data routes: one route per asset class (and optional venue)
with a primary feed and at most one fallback. With many accounts (ADR 0106), a person wants an
account to price from the feed that matches its broker, with more than one fallback, and to choose
what happens when that feed stops. A live account should not trade on a different feed without a
person knowing.

## Decision

- **N314: an account's own feeds.** An account can list its own price feeds in order
  (`account_feed`, migration 0105): the first is its primary, the rest its fallbacks, up to five.
  Only feeds that give live prices can be listed. They are set in Settings › Accounts with **Data
  feeds**; the Data feeds column shows the chain ("Alpaca → Demo feed"). An account with no feeds
  of its own prices through the data routes exactly as before, so nothing changes until a person
  sets some.
- **If the data feed stops** (`trading_account.feed_failure`): "Use the next fallback feed" or
  "Pause this account's runs". Null means the default of the account's kind: fallback for paper,
  pause for live. The live default is dormant until live accounts exist (P3).
- **N315: the chain is judged once per run pass,** before the pass reads any price, on the first
  instrument it asks for (`chainStep`, pure, in `@tm/domain`). A feed is healthy when it answers
  and, while the market is open, its quote is no older than 60 s (the route rule, ADR 0016).
  - Fallback mode: when the feed pricing the account stops, the account moves to the next feed in
    the chain that answers (then wraps to the top), or stays if none does. The account records the
    feed in use (`feed_active_id`). The switch opens an **Account data feed** incident
    (`account_feed`) on the account ("Now pricing from the fallback feed …") and a notification; a
    later switch to a further fallback updates the incident and notifies again. Runs keep going and
    show "Now pricing from the fallback feed …" on Orders. Once the primary has looked healthy for
    5 minutes, prices move back to it, the incident closes and a notification says so.
  - Pause mode: the account's running runs pause with the reason in words; positions stay and
    orders are not canceled. A run resumed while the feed is still down pauses again on its next
    pass. When the feed answers again the incident closes and a notification says so; the runs stay
    paused until a person resumes them.
  - The switch is conditional on the feed the pass saw in use, so concurrent passes of runs on the
    same account switch and announce it once. Every switch is audited
    (`trading_account.feed_switched`); changing an account's feeds is audited
    (`trading_account.feeds_changed`), starts again from the new primary and closes an open
    Account data feed incident.
- **N316: every order records the feed that priced it** (`order_intent.priced_by_feed_id`): quotes
  carry the id of the feed connection that answered, through routes too, and the order intent keeps
  it beside its reference price.
- Account valuations mark the account at its feed in use but never switch it; only run passes do.

## Consequences

- Bars for rules and back tests still come through the data routes (O186).
- Failover stays per account, not per instrument: when the feed pricing an account stops, all its
  runs move together, and every order after the switch is stamped with the fallback's id (A5).
- P3's rule that live runs need a real-time feed can check the account's chain.

## Open points

- **O185:** the chain is judged on the first instrument a pass asks for, once per pass, not on
  every instrument.
- **O186:** only live prices use the account's feeds; bars still come through the data routes.
- **O187:** valuations read the account's feed in use and never switch it.
- **O188:** prices move back to the primary on their own after 5 healthy minutes (as routes do); in
  pause mode the runs stay paused after the feed recovers.
- **O189:** the dialog always saves an explicit choice, so an account set once no longer follows the
  default of its kind.
