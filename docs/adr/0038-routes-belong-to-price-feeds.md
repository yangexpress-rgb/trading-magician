# ADR 0038: Routes belong to their price feed

- **Status:** accepted
- **Date:** 2026-11-06
- **Design refs:** §9.2, §9.4, §15.4; refines ADR 0016

## Context

Settings › Data feeds listed price feeds and, separately, a table of routes that each had to be
set up by hand or were added only when no other feed covered an asset class. Removing a feed was
refused while any route still used it. Yong asked for the routes to be listed under each price
feed, made automatically when a feed is added, and deleted with it.

## Decision

- **A route belongs to its primary feed.** The route model is unchanged (one route per asset
  class, venue and data type, with a primary and an optional fallback, ADR 0016), so resolution
  and failover are untouched. The page shows each route under its primary feed, with its backup
  feed and where prices come from now. Under the backup feed it is listed as "Backup for …", with
  a button that makes that feed the primary (the two swap). The separate Routes table and its
  "Add a route" dialog are gone; the routes API stays.
- **Adding a feed makes its routes.** For each asset class it covers, for bars and live prices,
  on any US venue (on the demo venue for a demo feed): where no route exists, one is created with
  the new feed as primary; where another feed's route has no backup yet, the new feed becomes its
  fallback. Turning a feed back on does the same. Both are audited as system actions.
- **Removing a feed deletes its routes.** Every route it is the primary for is deleted, it is
  removed as the fallback of other routes, and the remaining price feeds, oldest first, fill the
  gaps it leaves, so a route it owned moves to its backup feed. Removal is refused while a running
  strategy gets prices from the feed; turning it off first moves its routes or pauses those
  strategies (§9.4). A strategy pinned to a deleted route goes back to default routing.

## Consequences

- A feed's routes are visible where the feed is, and removing a feed no longer needs routes to be
  moved by hand first.
- Venue-specific or trades routes can still be made through the API; they show under their
  primary feed and are deleted with it.
