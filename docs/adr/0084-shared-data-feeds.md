# ADR 0084: Members use the admin's data feeds when they have none

- **Status:** accepted
- **Date:** 2026-11-12
- **Design refs:** design v1.2 row N237. Extends ADR 0016 (routes), ADR 0031 (company data
  feeds), ADR 0047 (options data feed) and ADR 0050 (admin's Alpaca key for the options recording)

## Context

Yong asked on 2026-11-12 whether the data feeds he set up as admin could be shared with every
member, so testers do not each have to register an Alpaca key, SEC EDGAR and the CBOE options
feed before anything works. Feeds, routes and sealed keys belong to one tenant under row-level
security, and only the worker (tm_secrets) can open a key. The options recording and the event
jobs already fall back to the oldest admin's feeds (ADR 0050, ADR 0058).

## Decision

- **Fallback by kind.** A member with no active feed of a kind (prices, company data, options
  data) uses the active feeds of that kind belonging to the oldest platform admin who shares. The
  kinds are separate: a member who adds only SEC EDGAR still gets the admin's prices. A member
  who adds their own feed of a kind uses theirs, and only theirs, for that kind. Earnings feeds
  were already global (ADR 0058).
- **On by default, per admin.** `platform_admin.shares_feeds` (default true). The admin turns it
  off with "Share my data feeds with all members" in Settings › Data feeds; the change is audited
  (`admin.feeds_shared` / `admin.feeds_unshared`).
- **Names only reach members.** `shared_data_feeds()` and `shared_data_routes()` are SECURITY
  DEFINER functions returning the sharing admin's active feeds' id, name and provider, and what
  their price routes cover. Row-level security on the feed tables is unchanged for the app; the
  migration owner gets a SELECT policy limited to the sharing admin's rows so those functions can
  read them. Members see "Shared by the admin" on their Data feeds page.
- **Keys open in the admin's tenant.** In the worker, `feedScope(db, userId, kind)` says whose
  feeds serve the member. Routes and feeds are read, keys opened, provider bookkeeping (custom
  feed caches and usage, the per-key Alpaca budget) kept, and failover applied in the admin's
  tenant, each in a short transaction of its own. Everything that belongs to the member (lookups,
  instruments they picked, charts, screens, reports, strategies and orders) stays in theirs.
  Covered: strategy passes, valuations, back tests, price charts, instrument lookups, stock
  groups, the screener, company reports and point-in-time fundamentals.
- **Web checks follow.** Research search, the screener, company data, options data and the
  strategy builder's "has a feed" checks count the shared feeds.

## Alternatives

- **Copy the admin's feeds and keys into each member's tenant.** Simple for the runtime, but puts
  the admin's key in every tenant and leaves stale copies when the admin changes it. Rejected.
- **Open the feed tables to members through row-level security.** Members' own routes and the
  admin's would mix, and members could read the admin's feed settings. Rejected.
- **A platform-wide feed set separate from the admin's.** Cleaner for production, but a second
  set of screens for a testing need. Can come later.

## Consequences

- Members' requests count against the admin's key limits (Alpaca's per-key budget, ADR 0052),
  and a failover on a shared route notifies the admin, not the member.
- When the admin's feed fails or the admin stops sharing, members without their own feeds lose
  data until they add one.
- The worker's database pool grows from 4 to 6, since a pass may hold its tenant's transaction
  while opening a short one in the admin's.
- Migration 0086 adds `platform_admin.shares_feeds`, the functions above and the owner policies.
