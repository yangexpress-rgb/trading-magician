# ADR 0109: The live gate

- **Status:** accepted
- **Date:** 2026-11-23
- **Design refs:** design v1.3 §1 (principle 7), §12.3, §12.5, §15.2; N317 to N321; O190 to O196.
  Phase 7 brief §6 ("Live gate") and §4 (real-time feed for live runs), build P3, started at Yong's
  OK on 2026-11-23. Builds on ADR 0017 (Alpaca, paper only), ADR 0106 (runs on accounts), ADR 0107
  (account risk layer) and ADR 0108 (account feeds).

## Context

Until now the app could trade paper only: a hard-coded `LIVE_TRADING_ENABLED = false`, database
checks that every credential, platform, account, run and order is paper, and an Alpaca client that
refused any host but paper. The Phase 7 brief asks for live trading as a capability, not a default:
nothing changes until the server turns it on, and then each real-money step needs its own
deliberate action. Building it must not turn live trading on.

## Decision

- **N317: the server's flag and the environment check.** `LIVE_TRADING_ENABLED=true` on the server
  (`liveTradingEnabled()`, off by default) is the only switch. With it off the app behaves as before:
  no live key, platform or account can be added, no run starts or resumes on a live account, and
  the worker refuses to open a live account's broker. The paper-only database checks are replaced
  by an environment check (migration 0106): an account's mode is its platform's environment, a
  run's mode its account's, an order's mode its run's (triggers, `23514`). At the broker adapter the
  run's account's environment picks the endpoint: the Alpaca client takes `environment` and allows
  the live host (`https://api.alpaca.markets`) only for a live account and only with the flag on;
  the account's key must be for the same environment.
- **N318: pilot mode.** A new live account trades under hard caps, $500 per order and $2,500 total
  exposure by default (`trading_account.pilot_max_order`, `pilot_max_exposure`). The owner can change
  them within a ceiling of $5,000 and $25,000 (**Pilot caps** in Settings › Accounts) and ends pilot
  mode with **End pilot mode**, a separate confirmed action (`pilot_ended_at`, audited, with a
  notification). Openings above a cap are refused before the broker with the plain reason ("Pilot
  cap per order: $5,000, limit $500"; `risk_pilot_order`, `risk_pilot_exposure`). The account's own
  limits and each strategy's still apply.
- **N319: adding a live platform** needs the flag, a live Alpaca key (sealed in the same vault,
  `credential.environment = 'live'`), a platform admin (inviting members is a separate launch
  decision) and the person's real-money acknowledgement in the Add platform dialog
  (`broker_connection.real_money_acknowledged_at`, required by the database for live). The dialog
  shows Paper or live only while the flag is on. A live account is never the default for new legs.
- **N320: pattern-day-trader awareness.** The 5-minute account valuation keeps what the broker last
  reported (`broker_equity`, `broker_day_trades`, `broker_margin`; Alpaca `daytrade_count`). A live
  account shows its day trades in the last 5 days, and starting an intraday run on a live margin
  account under $25,000 warns: "This account is under $25,000 — the broker limits it to 3 day
  trades in 5 days."
- **N321: starting a live run.** It has its own confirmation, separate from paper: **Start on real
  money?** names the strategy, the account (LIVE), the account's limits and its pilot caps, and needs
  a real-money checkbox; the request carries `mode: 'live'` and `liveConfirmed: true` with the
  account. The server refuses a start whose mode is not the account's, a live start without that
  confirmation, a live start with the flag off, and one whose prices come only from delayed feeds
  ("This account's data is delayed — live trading needs a real-time feed."). The feeds checked are
  the account's own chain (ADR 0108), else the routes for the strategy's instruments. Each refused
  live start is recorded in the audit trail (`strategy.live_start_refused`).

## Consequences

- Nothing live is possible on staging or production until a person sets `LIVE_TRADING_ENABLED=true`
  on the web and worker services and then adds a live platform with a live key.
- Turning the flag off again stops live runs from resuming or reaching the broker; their positions
  stay at the broker.
- Acceptance: A7 is covered by `packages/db/test/live-gate.test.ts` (delayed-only chain refused and
  recorded) and `apps/worker/test/runtime.test.ts` (an order above the pilot cap refused with the
  plain reason, before the broker); A8 by the same db test (no live platform with the flag off),
  `credentials.test.ts` and the e2e suite (no Paper or live choice).

## Open points

- **O190:** pilot caps apply to opening orders only, so a close is never trapped by them.
- **O191:** the ceiling on pilot caps before pilot mode ends is $5,000 per order and $25,000 in
  total.
- **O192:** live platforms are for platform admins only until inviting members is decided.
- **O193:** a live platform does not check the plan's paper-integration feature; plans for live are
  out of scope (billing).
- **O194:** a run counts as intraday for the PDT warning when its rules or its Check Entry or Check
  Exit read bars under a day, or it flattens at session end; the warning shows only once the broker
  has reported the account's equity, and not for a cash account.
- **O195:** the day-trade count and equity are the broker's figures from the latest account
  valuation (every 5 minutes), not counted by the app.
- **O196:** a live account can't be made the default account for new legs.
