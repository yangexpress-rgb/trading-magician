# ADR 0123: Options trading on paper (brief v0.2, Phases O0 to O3)

- **Status:** accepted (O0)
- **Date:** 2026-11-27
- **Design refs:** "Trading Magician — Options Trading: Design Brief", draft v0.2 (Drive file
  `trading-app-options-trading-brief-v0.2.md`); N353 to N360; open points O219 to O221; migration 0118. Each later phase amends this ADR with its own rows.

## Context

The app records options data for research but cannot trade options. The brief adds options
execution for paper accounts at existing seams, behind one switch, `OPTIONS_TRADING_ENABLED`, off
by default. Its overriding rule: with the switch off, stock and ETF trading behaves exactly as
before, to the cent. Three things make that hard: reconciliation (an unknown holding pauses every
run on an account), account netting (one net position per symbol per account), and the shared
Alpaca key (200 requests a minute, already breached once by equity traffic alone).

## A1 reference back tests (recorded before any code change)

Recorded on main `576f055` before any options code was written, in
`packages/backtest/src/a1-reference.test.ts`. Each phase must re-run them to the same figures and
the same behaviour fingerprint (the hash of every order, fill and trade).

| Reference                                                                                                                                                         | Final equity | Net return | Max drawdown | Closed cycles | Orders | Fills | Trades | Fingerprint        |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ | ---------- | ------------ | ------------- | ------ | ----- | ------ | ------------------ |
| Single asset: close above SMA(200), the trend fixture on SPY daily bars                                                                                           | 107,423.48   | 7.42%      | 5.68%        | 6             | 13     | 13    | 7      | `359f3c8d617a2e6e` |
| Group: top 3 of 9 sector ETFs by 6-month return, each above its SMA(200), synthetic bars, 2023-06-01 to 2025-06-30                                                | 121,973.27   | 21.97%     | 16.85%       | 72            | 147    | 147   | 75     | `c7b22c401990fa85` |
| Intraday: opening-range breakout (5-minute close above the 30-minute opening high), 50 units, flatten at the session end, 2025-03-03 to 2025-03-14, 5-minute bars | 100,992.83   | 0.99%      | 0.16%        | 10            | 20     | 20    | 10     | `cf4525b1524509b4` |

Separately, `packages/domain/src/execution/multiplier-a1.test.ts` keeps frozen copies of the
sizing and risk functions from `576f055` (`execution/a1-legacy/`) and checks, over 3,000 generated
cases (fixed seed), that the new functions give byte-identical results for a multiplier of none,
`1` and `'1'`.

## Decision: Phase O0 (foundations, no options orders)

- **One switch** (N353). `OPTIONS_TRADING_ENABLED` is on only for the exact value `true`. While it
  is off an options leg fails validation with a plain reason, the worker gets no options lifecycle
  job, and no options order can be placed. In O0 an options leg is refused even with the switch on
  (`options_not_built`), and the runtime skips any options leg it meets with a warning; O1 lifts
  this for long legs.
- **The leg's optional `option` field** (N354): right, strike rule (`atm`, or `moneynessPct`
  from −50 to 50) and expiry rule (`targetDte` 1 to 730, `minDte` 0 to 730). No schema version
  bump; definitions without it parse and hash unchanged. Options legs can't be in an entry group.
- **Contracts are Core instruments** (N355). `register_option_contract(...)`, a SECURITY DEFINER
  function granted to the worker only, inserts or finds the option instrument on the identity key
  (safe when two runs resolve the same contract at once), checks the OCC symbol, a stock or ETF
  underlying that isn't demo data, and a positive strike and multiplier. Venue `OPRA`, display name
  `ROOT strike right expiry`. The web can't call it. The Lab's instrument choices leave option rows
  out.
- **The options level is read from the broker** (N356). `trading_account.broker_options_level`
  (0 to 3, null while unknown) is written with the broker's balances from Alpaca's
  `options_trading_level`, and merged into the account's capabilities when a strategy is
  validated. Nothing assumes a level.
- **Start gates and isolation by account** (N357). At Start, a strategy with options legs needs the
  switch on, a paper account, not the simulator, the level its legs need (long options 2, a combo
  3, covered structures 1), and an account with no stock or ETF runs. A stock or ETF strategy can't
  start on an account carrying options runs. Each refusal is one sentence naming the account and
  the rule. `strategy_runtime.trades_options` records which runs trade options. Stopped runs don't
  count.
- **The multiplier pass-through** (N358). Sizing, pre-trade risk, the runtime book's cash,
  pending-entry gross, the equity limits and the account exposure book use price × multiplier.
  When the multiplier is 1 (every stock and ETF) the price itself is used, the very same value, so
  equity figures are identical by construction.
- **A third Alpaca budget class for options quotes** (N359). Options requests go only while the
  minute leaves 40 requests of room for equity, at most 40 in any minute, and stand aside for the
  pause after a throttle, like background work. They never wait: with no room an options request
  fails at once (`AlpacaOptionsBudgetError`).
- **Brokers say whether they trade options** (N360). `BrokerCapabilities.options`; the simulator
  says no, and both brokers refuse an options order request unless they say yes. The shared broker
  contract suite tests this. Alpaca's adapter says no until O1.
- **The lifecycle job runs before reconciliation** (N360). The runtime worker calls the options
  lifecycle for an account before reconciling it, only while the switch is on, and the job acts
  only on accounts with an options run. In O0 its one duty is to register an OCC holding the app
  has no instrument for, so reconciliation sees a known instrument (O220).

## Open points and deviations

- **O219 — The options level has its own column.** The brief puts the level in the account's
  `capabilities` record. That record is written by the platform check, while the level arrives
  with the account's balances, so a separate nullable column keeps the capabilities record's
  meaning unchanged (principle 1). Validation sees it merged into capabilities, so the effect is the
  brief's. Proposal: keep.
- **O220 — An outside OCC holding is registered with a multiplier of 100.** Alpaca's positions
  don't report a multiplier, and O0 has no contract list. A holding whose root has no stock or ETF
  instrument stays unknown, and reconciliation pauses the runs on that options account only.
  O1 reads the multiplier from the cached contract list instead.
- **O221 — Options requests never wait for budget.** The brief asks for a class below equity and
  above background. A runtime pass handles strategies one after another, so an options request
  that waited would hold every equity strategy's pass back. An options request with no room is
  not sent, and the quote gate then refuses on the quote's age. Proposal: keep.

## Acceptance (O0)

- **A1:** pass. Unit suites 1,393 passed (1,366 on `576f055` plus 27 new); integration suites
  664 passed and 14 skipped (654 and 14 on `576f055`, plus 10 new). The three reference back tests and the byte-identity fixture pass.
- **A8 (budget part):** pass. A load fixture with options quoting on stays under 200 requests a
  minute, and equity requests are never refused or delayed by options traffic. The quote-age and
  spread parts belong to O1, which adds the quote gate.
- **A10:** pass against the database: level 0, a combo at level 2, the simulator, switch off, an
  equity run on an options account and an options run on an equity account are each refused with
  their sentence; an equity strategy starts normally. The live-account refusal is covered by the
  domain test (no live account can be connected in the test database).
- **A11 (first part):** pass. A registered OCC holding is a known instrument, reconciliation pauses
  nothing, and the equity account's runs are untouched. The assignment part follows in O2.
- **Level read from the staging paper accounts:** pending. The worker records it on its next
  account read after the deploy; it has to be read back on staging, and the options account does
  not exist yet.

## Consequences

- Stock and ETF strategies run the same code paths with the same numbers.
- Every options phase adds rows, tests and fixtures to this ADR and must keep A1 passing.
