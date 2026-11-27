# ADR 0123: Options trading on paper (brief v0.2, Phases O0 to O3)

- **Status:** accepted (O0, O1)
- **Date:** 2026-11-27
- **Design refs:** "Trading Magician — Options Trading: Design Brief", draft v0.2 (Drive file
  `trading-app-options-trading-brief-v0.2.md`); N353 to N360 and N361 to N366; open points O219 to O221 and O222 to O232; migrations 0118 and 0119. Each later phase amends this ADR with its own rows.

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

## Decision: Phase O1 (long calls and puts)

O1 trades one long call or put per options leg, bought to open in Entry and sold to close in
Exit, on paper accounts at level 2 or above, with the switch on. Everything below runs only while
the switch is on; with it off the code paths are not reached.

- **The contract resolver and cached contract lists** (N361). An Entry leg is resolved on its
  decision date (§6.1): the standard contracts (multiplier 100, OCC root equal to the underlying)
  of its right, the expiry nearest `targetDte` that is at least `minDte` and never the decision
  date itself (tie: the later one), then the strike nearest the underlying price × (1 +
  `moneynessPct`) (tie: the lower for a call, the higher for a put). The contract list of each
  underlying is cached once a day in `option_contract_list` (migration 0119), written and read by
  the worker only, with a version hash recorded on the order. An outside OCC holding now takes its
  multiplier from this list when the list has it, and 100 otherwise (O220's follow-up).
- **The quote gate** (N362). An options order is sent only on a two-sided quote no older than
  60 s in market hours, with a spread no wider than 30% of the mid (`OPTIONS_MAX_SPREAD_PCT`).
  Quotes come from Alpaca's options quotes endpoint on the options budget class, at most every
  15 s per contract. A refused order is not sent and the reason names the contract and the figure.
- **Entry orders** (N363). A day limit at the mid, in cents. After
  120 s unfilled it is re-priced once to mid + (ask − mid) ÷ 3 for a buy (mid − (mid − bid) ÷ 3 for a
  sell), rounded away from the mid, through the broker's replace (`PATCH /v2/orders/{id}`); 120 s after that it
  is cancelled and the cycle ends as it would after an equity leg timeout. Equity legs keep 60 s.
  An Entry decided while the market is closed records its pick in the run's state and resolves
  again at the open; when the pick changed, the order says so ("decided overnight", A13).
- **Exits and expiry day** (N364). Two exit rules: `optionTarget` (close when the premium is up
  this % on the premium paid) and `optionDte` (close this many calendar days before expiry). They
  are judged at Check Exit, like other position exits. On a contract's expiry day the runtime closes
  what is still held from 15:00 New York time with a limit at the mid ("Closed before expiry"),
  moves that limit to the bid (sell) or ask (buy) at 15:20, and never cancels it. An expiry-day
  close needs a two-sided quote no older than 60 s (any spread). After expiry, a contract the
  broker no longer holds and that was out of the money on the underlying's last price seen that
  afternoon is settled at 0 before reconciliation ("Expired worthless": a fill of kind `expiry`,
  migration 0119), so reconciliation finds nothing to pause on. Anything else is left to
  reconciliation, which pauses the options account's runs only (O226).
- **Back tests with options** (N365). A strategy with options legs back tests on daily bars from
  2024-02-01, on Alpaca's contract list (active and expired) and the daily trade bars of each
  contract it picks, loaded in passes (at most 5). Picks are point in time: a contract counts as
  listed from its first trade bar, so later listings and later bars change nothing (A9). Fills are
  at the next bar's open ± 5% of premium (`OPTIONS_FILL_SLIPPAGE_PCT`), × 100 a contract; order
  value and risk limits use premium × 100 (A7). On expiry day a held contract closes at that day's
  close, or, with no trade that day, settles at its intrinsic value on the underlying's close (0:
  Expired worthless, more: Exercised, as cash) (A6). Results say "Options priced from trade
  prices, not quotes".
- **Alpaca trades options; the builder, orders and contract suite show it** (N366). The Alpaca
  adapter says it trades options when the account's level is 2 or more and an options client is
  given; it reads quotes and contract lists, sends OCC orders with `position_intent`
  (`buy_to_open`, `sell_to_close`, ...), replaces orders under a new client order id ending `_r`,
  and reads a replaced order as neither cancelled nor a new order. The shared broker contract
  suite gains a test both brokers pass: either trade options with quotes, contracts and replace, or
  refuse them all; it runs for the paper broker, Alpaca, and Alpaca at level 2. The builder shows
  "Trade options on this instrument (paper only)" on a leg only while the switch is on (or when the
  leg already has one), with right, strike % from the money, target DTE and minimum DTE. Order
  details show the contract in words, the quote it was sent on and an overnight decision. A
  strategy trailing stop under 25% on an options strategy draws a warning to acknowledge, since it
  is measured on premium.

### O1 deviations

- **O222 — Re-pricing is a broker replace, not cancel and resend.** The brief says the order "is
  re-priced". A cancel and resend leaves a window with no order and a second app order; a replace
  keeps one app order. The replacement carries the client id `<key>_r`, and its fills are booked
  to the original app order. Proposal: keep.
- **O223 — A fill of kind `expiry` at price 0.** The fill table's price had to be positive.
  Migration 0119 adds `fill.kind` (`trade` default, or `expiry`) and allows 0 only for `expiry`, so
  every existing row and every equity fill still has to be positive.
- **O224 — An Entry decided while the market is closed places no order until the open.** The
  brief's A13 asks that the decision be visible and re-made at the open. Equity legs queue an
  order for the next session; an options leg records only its pick (state `options.picks`) and
  resolves again at the open, since a contract can't be priced overnight.
- **O225 — `optionTarget` is % on the premium paid.** The brief says "% of max profit". A long
  option's max profit is unbounded (a call) or the strike less premium (a put), so % of the premium
  paid is the only measure that applies to both; combos (O2) use max profit.
- **O226 — Worthless is judged on the run's last underlying price after 15:00 on expiry day, not
  the official close.** The app has no official closing print at settlement time; a contract more
  than 0 in the money, or with no price seen, is not settled by the app but left to reconciliation
  (which pauses only that options account's runs). Exercise and assignment handling is O2.
- **O227 — Option quotes don't feed the feed-loss pause.** The 60 s stale-price pause watches the
  underlying, not the contracts; a contract with no quote refuses the order instead (N362), so a
  quiet contract never pauses the equity runs' account.
- **O228 — Option exits are judged at Check Exit.** Like every other position exit; expiry-day
  closes run on every pass regardless.
- **O229 — Back tests are daily, from 2024-02-01, on trade bars.** Alpaca keeps contract bars by
  the day only, from February 2024, and has no historical quotes. Listing is approximated by the
  first trade bar; standard contracts by the OCC root; fills have no volume cap or price collar;
  the loader stops after 5 passes with a warning.
- **O230 — Safety closes of options are limits, never market orders.** A market order on an
  options contract can fill far from its value; safety closes go at the mid, or the touch on expiry
  day after 15:20.
- **O231 — Strategy trailing stop on options: a warning, not a change.** The 1% default (N291)
  measured on premium would close a long option on ordinary noise. The value is left as saved, and
  validation warns under 25%. Proposal: Yong decides whether options strategies start with it off.
- **O232 — Alpaca's real options behaviour is unverified.** Time in force, replace semantics, the
  `replaced` status and expiry handling are built to Alpaca's documentation and tested against the
  fake. They are checked against the real options paper account once it exists (pending the
  options account).

## Acceptance (O1)

- **A1:** pass. Unit suites 1,431 passed (1,393 on `83a9df0` plus 38 new); integration suites
  670 passed and 14 skipped (664 and 14 on `83a9df0`, plus 6 new; the O0 test that a long call is
  refused at Start now checks that it starts). The three reference back tests and the byte-identity fixture pass unchanged.
  The fake Alpaca's order shape is unchanged for orders that were never replaced.
- **A2 (long legs):** pass. A long call is resolved, bought at the mid, re-priced to 2.14 on a
  2.10/2.20 quote, filled, and sold on its premium target with P&L $120 (worker
  `test/options-runtime.test.ts`).
- **A6:** pass. Paper: an expiry-day close at the mid then the bid (−$60, Closed before expiry), and
  an out-of-the-money contract settled at 0 (−$200, Expired worthless) with no reconciliation
  pause. Back test: the same two outcomes (backtest `options.test.ts`).
- **A7 (long legs):** pass in back tests: 3 contracts at 2.00 count as $600 against the order
  limit (599 refused, 600 allowed). The paper path uses the same multiplier pass-through (N358).
- **A8:** pass. A 90-second-old quote and a 45% spread each refuse the order with their reason and
  no order request is sent.
- **A9:** pass. A contract listed later, or later bars of the picked contract, change no trade.
- **A13:** pass. An Entry decided overnight resolves again at the open, picks the better contract
  listed since, and the order shows the overnight decision.
- **Against the real options account:** pending the options account (O232).

## Decision: Phase O2 (defined-risk combos)

O2 trades combos: two to four options legs of one Entry on one underlying and one expiry, placed as
one multi-leg order on paper accounts at level 3, with the switch on. With it off nothing below is
reached.

- **One order, all or none** (N367). The broker contract gains `MultiLegOrderRequest` (legs with
  ratios in lowest terms, one signed net limit, sets) and `submitMultiLeg`, behind a new
  `optionCombos` capability (O233). Alpaca sends `order_class: mleg`; each leg's updates come back
  under `<combo key>.<OCC symbol>`, so every leg intent keeps its own row, and the intents share
  the broker order id and a new `order_group_id` (migration 0120). Reconciliation reads such an
  order's updates per leg. A refused combo places nothing; the shared contract suite checks it.
- **Bounded at save time, dollars at pricing time** (N368). Validation requires, per underlying,
  one expiry rule, at most 4 legs and whole contracts (O234), and refuses a combo selling more
  calls than it buys (`options_naked_call`) or more puts (`options_cash_secured_put`). Any combo
  or sold leg needs level 3 to start. At pricing, max loss = (net debit − worst expiry payoff) ×
  100 × sets and the buying-power reserve = (full width + any debit) × 100 × sets; the order and
  exposure limits see the max loss, buying power the reserve, and the price collar is skipped.
  Fixtures: the 105/110 vertical's worst case $500, $380 at a 1.20 credit; the condor $350 at
  1.50; two condors $700, one reserves $500 (A3, A7).
- **Combos on paper** (N369). The first combo leg the planner reaches resolves every leg (the
  later ones on the first's expiry), gates each quote, prices the net at the leg mids and places
  the combo; the others find it placed. Unfilled after 120 s, each leg moves a third of the way to
  its touch and the order is replaced once; 120 s later every leg is canceled. An Exit closes all
  the cycle holds on that underlying as one order, each contract on the Exit leg that undoes it.
  If the broker refuses that close, or it ends unfilled, the contracts close one by one, short
  legs bought back first: a long contract is never sold while the cycle is short an option on the
  same underlying (this also orders every other safety close). Held options count what they can
  still lose by expiry, so a combo counts its max loss (a long contract alone its premium, as in
  O1); a working combo counts its max loss once. The profit target reads the combo whole, as % of
  max profit (O235).
- **Delta strike rule** (N370). `strikeRule: { type: 'delta', delta }` picks, on the chosen
  expiry, the contract whose |delta| is nearest (tie: the larger). Greeks are the broker's from
  the options snapshot, else the app's own Black-Scholes delta from each candidate's quote mid
  (O236); the order records which.
- **Assignment** (N371). Before reconciliation, a short contract the broker holds fewer of, with
  exactly 100 shares a contract of the underlying delivered (bought for a put, sold for a call),
  is recorded as `assignment` fills: the contract bought back at 0 and the shares at the strike,
  in the cycle. The cycle then closes the rest of the combo and the shares in the regular session
  ("Assigned: ..."). The next morning Alpaca's OPASN/OPEXC/OPEXP activities confirm it or the run
  is flagged (O237–O239). Anything that doesn't add up is left to reconciliation.
- **Dividend watch and the day-early close** (N372). Alpaca's cash-dividend announcements are read
  at most once a day per underlying a short call is held on, into `option_dividend` (migration
  0120, worker only). On the trading day before an ex-date, a short call in the money whose time
  value is below the dividend closes its combo ("Closed before a dividend", exit reason
  `dividend_risk`). A short leg within 2% of the money closes from 15:00 the day before its
  expiry (O245).
- **Back tests and the builder** (N373). A back-tested combo is picked once (one expiry; the delta
  rule from each candidate's close), risk-checked once as a whole on max loss and width, and each
  leg fills at its contract's next open (O240); each Exit leg closes its own contract and the
  profit target reads the combo whole. The builder names an options leg's sides Buy/Sell to open
  and Buy/Sell to close and offers "Strike by: Delta".
- **Two O1 gaps fixed.** Mirrored Exit legs now keep their Entry leg's option, and an options
  order re-sent after the broker was unreachable goes as an options order again.

### O2 deviations

O233–O246 in `docs/design/v1.2-deviations.md`, each with its reason: the separate `optionCombos`
capability; whole contracts for combo legs; the combo profit target's base; the app's own delta
fallback; assigned combos closed with their shares in the session; the morning check confirms or
flags; long exercise left to reconciliation; back-tested combos fill leg by leg, with assignment,
dividends and the day-early close paper-only; the put cash rule as the width reserve; adjusted
held contracts not yet detected; delta-adjusted exposure not yet displayed; the account limit
counting legs' premiums; "near the money" as 2%; and Alpaca's multi-leg behaviour unverified
until the options account exists.

## Acceptance (O2)

- **A1:** pass. Unit suites 1,465 passed (1,431 after O1 plus 34 new); integration suites 677
  passed and 14 skipped (670 and 14 after O1, plus 7 new). The three reference back tests pass
  unchanged. Equity paths: the exposure, pending-gross, risk and planner changes apply only to
  option contracts, combo intents or the new inputs, which equity runs never have.
- **A3:** pass (domain `options/combo.test.ts`): naked short call and lone short put refused each
  with its reason; vertical worst case $500; $380 at 1.20; condor $350 at 1.50.
- **A4:** pass on the fake (worker `test/options-combos.test.ts`): one POST for a two-leg combo; a
  refused combo leaves both legs failed, nothing held, the cycle aborted; a refused combo close
  buys back the short leg first, then sells the long, with the path on each order. On staging
  paper: pending the options account.
- **A7:** pass: two condors held count $700 (worker `equity-limits.test.ts`, domain
  `combo.test.ts`), two sets' order carries max loss 2 × (width − credit) × 100 and a reserve of
  2 × width × 100; one condor reserves $500. Back test: a 2-set vertical counts $800 (799 refused).
- **A11:** pass on the fake: an assignment's shares are explained before reconciliation, no
  mismatch is opened, the combo and shares close at the open, and the next morning confirms it.
- **A12:** partial: the flow passes on the fake; on staging paper it is pending the options
  account.
- **A5, A10:** unchanged from O0/O1 (A10 adds the level-3 gate for combos, covered by the
  options-trading start checks).

## Consequences

- Stock and ETF strategies run the same code paths with the same numbers.
- Every options phase adds rows, tests and fixtures to this ADR and must keep A1 passing.
