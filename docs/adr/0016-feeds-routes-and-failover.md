# ADR 0016: Data feeds, routes and failover

- **Status:** accepted
- **Date:** 2026-10-05
- **Design refs:** §9.2, §9.4, §14.4, §15.4

## Context

Phase 4 lets people bring their own market-data providers next to the built-in demo feed. The
design asks for a feed list with health and entitlement, routes from an asset class, venue and
data type to a primary and a fallback feed, automatic failover, and rules for turning off a feed
that running strategies depend on (§9.4). The failover switch-back default (5 minutes healthy)
was confirmed with the Phase 4 plan.

## Decision

- **Routes are deterministic.** A route names an asset class, an optional venue and a data type
  (live prices, trades or bars). The route for the exact venue wins over the any-venue route for
  the same asset class and data type (`resolveRoute` in `packages/domain`). A route's fallback,
  when set, must differ from its primary, and both must cover the route's asset class and venue.
- **Demo instruments have their own venue.** Demo routes are pinned to venue `DEMO`; the demo
  provider covers only that venue and real providers cover everything else. A real provider's
  any-venue route therefore never captures demo instruments, and the demo feed never serves real
  ones. Migration 0018 moves existing demo routes onto `DEMO`.
- **Feed checks run in the worker.** Each active feed is checked at least once a minute, and at
  once when it is added or someone presses Test. The worker claims due feeds across tenants with
  a lease through `claim_feed_checks` (SECURITY DEFINER) and checks each inside its tenant. A
  check records health, entitlement, the last check time and a generic error message; raw
  provider errors are logged, never shown. A feed going down raises an in-app notification.
- **Failover is decided once per route per pass.** A primary with no quote, or one older than 60
  seconds, counts as down; prices then come from the fallback. After the primary has looked
  healthy for 5 minutes in a row, prices switch back; a relapse resets that clock (`failoverStep`,
  `FAILOVER`). Each change is a conditional update, so only one pass announces it, and each is
  audited (`data_route.failed_over`, `data_route.switched_back`) and notified.
- **Turning off a feed in use asks first (§9.4).** Turning off a feed that serves running or
  paused strategies is refused until the person picks one: move its routes to another active
  feed that fits, or pause those strategies with the reason "Its data feed X was turned off.". A
  feed that routes still use cannot be removed, and a route a strategy is pinned to cannot be
  deleted.
- **Live updates.** Feed and route changes notify `tm_execution`, so the Settings page refreshes
  over the existing stream (ADR 0013) and Test results appear without a reload.

## Consequences

- Real providers' quotes go through the same routed lookup as the demo feed, so M4.3 adds an
  Alpaca adapter without touching strategy evaluation.
- Instruments from a real provider are discovered in M4.3; until then real feeds can be added,
  tested and routed but no instrument uses them.
- Checks every minute per active feed are cheap for the demo provider; real providers' checks
  use a single lightweight request with a timeout.
