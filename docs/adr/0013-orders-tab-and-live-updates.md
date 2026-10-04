# ADR 0013: Orders tab, manual order actions and live updates

- **Status:** accepted
- **Date:** 2026-10-04
- **Design refs:** §5.1, §8.1, §8.3, §14.3, §15.2, §16.2

## Context

Paper strategies now place orders (ADR 0012). People need to see them as they happen, read why
each one exists, and act on them: cancel an order, stop a strategy with or without unwinding it,
and pause everything at once. Manual actions must stay distinguishable from what strategies do.

## Decision

- **API (§14.3).** `GET /orders` (views: all, working, filled, canceled or rejected, scheduled;
  filters: strategy, run, cycle, phase, instrument, account, dates in the viewer's time zone),
  `GET /orders/{id}` (intent, broker state, source rule, trigger event, risk checks, fills and the
  full event timeline), `POST /orders/{id}/cancel`, `POST /orders/cancel-all`, `GET /positions`,
  `POST /positions/close`, `GET /execution`, `POST /execution/kill-switch` and
  `POST /execution/runtimes/{id}/resume`. All run in the caller's tenant transaction under RLS.
- **Manual actions are the person's.** A cancel is recorded as a `user` order event and audited;
  the runtime sends it to the broker on its next pass. Closing a position creates a market order
  intent with `source: 'user'`, allowed only once the strategy is stopped, because a running
  strategy's Exit rules own its positions. Stop takes two separate, explicit choices, cancel
  working orders and close positions, both off by default (§8.1).
- **Kill switch.** Engaging pauses every running strategy; it cancels nothing. Cancel-all is a
  second, separately confirmed action. Releasing it resumes nothing; each strategy is resumed on
  purpose.
- **Live updates.** Triggers on `broker_order`, `scheduled_action`, `strategy_runtime` (status)
  and `execution_control` call `pg_notify('tm_execution', user_id)`. The web process holds one
  `LISTEN` connection and pushes a `change` server-sent event to that user's open tabs, which
  re-read through the API. Notices carry only a user id, so nothing leaks between tenants, and no
  Redis is needed yet. Tabs also refresh every 30 s in case a notice is lost.
- **Screen (§15.2).** Counts per view, filters kept in the address so a view can be bookmarked,
  a dense table with Paper labels, strategy and cycle links, a detail drawer, positions with
  manual close, and a banner for the kill switch and paused strategies. Starting a strategy links
  to Orders and highlights the new run.
- **Test clock.** `PAPER_CLOCK_START` (refused in production unless `E2E_TEST` is set) starts
  the worker's paper clock at a fixed instant, so E2E runs inside a simulated NYSE session.

## Consequences

- Times the database stamps (`submittedAt`) use the real clock while broker events use the paper
  clock; they differ only when `PAPER_CLOCK_START` is set.
- Saved views are bookmarks for now; named, stored views can follow with Phase 4 preferences.
- Reconciliation incidents (M3.5) will join the same banner.
