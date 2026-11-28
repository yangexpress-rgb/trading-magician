# ADR 0124: State-machine strategies (brief v1.3, Phase P1)

- **Status:** accepted (P1, the three metrics; P2a, the definition and evaluator; P2b, the back test engine; P3a, the paper runtime; P3b, the builder and reporting)
- **Date:** 2026-11-27
- **Design refs:** "Trading Magician — State-Machine Strategies: Design Brief" v1.3 (Drive file
  id `1dYuepl_NasusovfWAXfqDjKm37-S87t5`) and v1.4 (id `1MIj5DiAPV6zqDL_kxefGYd4qMug5wUDZ`, from P2b);
  N381 to N383, N384 to N386, N387 to N389, N390 to N392 and N393 to N397; open points O259, O260, O261 to O263,
  O264, O265, O266 to O268 and O269; migration 0121 (P3a).
  Each later phase amends this ADR with its own section.

## Context

The brief adds strategies that hold one named state at a time (T00078-ED, 纳指晴雨, on QQQ) and
switch between target holdings by an ordered, first-match list of rules. Its rules read three
daily metrics the registry does not have. P1 adds only those metrics, independent of the state
machine itself (P2 onwards). Rule A1 holds: no existing metric, indicator or back test changes,
and the A1 reference back tests (ADR 0123) still give the same figures and fingerprints.

## Decision: Phase P1

- **MA slope** (`ma_slope`, N381): SMA(`period`) today ÷ SMA(`period`) `bars` bars earlier − 1.
  Defaults MA20 and 1 bar; period 2 to 500, bars 1 to 250. Empty until both averages exist.
  Stocks, ETFs and indices.
- **Relative volume** (`relative_volume`, N382): today's volume ÷ the mean volume of the `window`
  bars before today; today is left out so a spike is not diluted by itself. Window 2 to 500,
  default 60. Stocks and ETFs only (indices have no volume). On Alpaca IEX bars it measures IEX's
  share of volume, which the help text says.
- **Drawdown from high** (`ath_drawdown`, N383): close ÷ the highest close − 1, 0 on a new high,
  never above 0. `window` > 0 uses the last `window` bars, today's included (`HIGHEST`);
  window 0, the default, uses all loaded history through a new indicator, `HIGHEST_EVER`, a running
  maximum whose look-back is `ALL_HISTORY_BARS` (5,040 bars, 20 years). The existing series
  planner therefore loads from the data start in back tests and on paper alike, with no special
  case in either loader (O259). `HIGHEST_EVER` is hidden from the builder: it is reached through
  the metric. Large groups with window 0 meet the bar limits (O260).
- All three read split- and dividend-adjusted daily bars and only bars up to the one they are
  evaluated on. They reach conditions, group filters and ranking like every registry metric; the
  screener's fixed columns are unchanged.

## Checks

- Each metric against a plain recomputation from the bars, at several dates and parameters
  (`packages/domain/src/strategy/state-machine-metrics.test.ts`).
- A2, no lookahead: every bar after t replaced (a new all-time high, a 50× volume spike) leaves
  each metric's value at t unchanged, for five parameter sets at three dates and three futures.
- The series plan for window 0 starts about 20 years before the run; for window 252 about a year
  and a half (`packages/backtest/src/data.test.ts`).
- A1: the domain, back test, worker and web suites pass unchanged, including
  `a1-reference.test.ts`.

## Consequences

- No schema change and no migration: the metrics are registry entries a saved strategy names.
- P2a (the state-machine form and its evaluation) can build on these metrics.

## Decision: Phase P2a (definition and evaluator, pure domain)

- **A top-level form** (N384). `form: "state_machine"` with its own `machineVersion` (1), so it is
  never mistaken for a rules document and never runs through the rules migrations; `trade` is
  `{ kind: "signals", instrumentIds }`, the instruments the rows read; `machine` holds states and
  rows; `execution` has no leg policy (sells first, buys after they fill, `after_prior_fill`);
  `risk` is strict, so a strategy trailing stop is refused, not dropped. `parseAnyDefinition` reads
  either form; `parseDefinition` refuses a state machine with `NotRulesDefinitionError`, so the
  readers of Entry and Exit never see one. Wiring the stores and lists to the union comes with the
  phases that store state machines.
- **The state operands are their own kinds** outside `Expr`: `state_is` and `row_ref` are
  conditions; `days_in_state` and `days_in_states` are comparison sides only (O261) and strict (an
  offset is refused). No rules-form condition, statistic or calculation can hold one by
  construction.
- **Validation** (N385) reuses the rules form's comparison and value checks for row conditions
  and adds the machine's own: an unconditional last row naming a state (the fallback), no
  unconditional row above it, known states and rows, no reference loops, daily bars of the signal
  instruments only, no position or session values, stock or ETF targets with a feed, and a warning
  when a % of equity limit is below the largest target. No daily loss limit by default (O262).
- **One evaluator** (N386). `decideDay` tests rows from the top; the first true row decides; a
  row naming the current state is a stay; an unknown row above any true row makes the day a stay.
  `machineView` derives current, prior, days in state and days in a set from the list of switches
  and the start day, walking back while the run came from inside the set. `replayMachine` runs the
  path over daily bars from the fallback state with no orders, for P2b's engine, A6 and Start's
  replay (§2.9).

## Checks (P2a)

- The §4 worked example (`machine-fixtures.ts`) parses unchanged and validates with no errors or
  warnings; a state machine carrying an old rules `schemaVersion` still parses untouched (the
  pass-through test any later rules migration must keep).
- Property tests (fast-check): the decision matches a reference model of first-match with
  unknown-means-stay over random rows; a row reference equals the referenced rule inline, inside
  OR and NOT.
- On a 1,500-day synthetic walk the example visits 10 of 11 states; no row wins before MA200
  exists (A5); every risk-off switch to ATTACK or NORMAL comes after 3 days in the set with MA20
  rising, and the lock holds on other days; a missing bar is a stay; A2: replacing every bar after
  t leaves the path up to t unchanged.
- A1: domain (719), back test (244, including `a1-reference.test.ts`), worker (81) and web (193)
  suites pass.

## Decision: Phase P2b (back test engine)

- **Brief v1.4's 16 rows** are the fixture: rows 4 and 5 send HI_CASH back to NORMAL_HV or NORMAL
  once close reclaims MA20 above MA200, judged before the deviation escape (O263 closed).
- **Rebalancing** (N387). `planRebalance` (domain, shared with paper in P3a) takes every
  instrument held or targeted; equity is cash plus holdings at the given prices; a leg's
  difference under 0.5% of equity is not traded; a zero target sells everything; otherwise whole
  lots toward the smaller trade. `underSwitchBand` (every leg under 5%) makes a switch with no
  orders, complete at once. The engine fills sells first, then sizes each buy from the cash left,
  so a buy never exceeds cash; the price collar cancels, the % of equity limits reject or cap,
  the 10% volume cap and max active orders apply as on the rules form.
- **Completion** (N388). A transition not done after its fill is tried again at each close for up
  to `COMPLETION_DAYS` (5) trading days after the transition day, then stuck, with a warning
  (O264). Done is judged at the fill's open prices, so drift after completion never trades. A new
  switch marks an unfinished transition superseded. Halts skip rebalance buys and let sells go.
- **One path** (N389). `simulateMachine` replays the decisions over every loaded bar with the
  shared `decideDay` and `machineView` (sessions counted on the bars), places no orders before
  `from`, and on the first run day moves holdings to the replayed state (a `start` transition),
  as Start does on paper (§2.9). The result is a `BacktestResult` with no trades and a `machine`
  report: each transition (row, Why checks through `machineConditionChecks`, outcome, attempts,
  orders) and each stay in a state with its return. Orders and fills carry the transition index as
  their cycle. Metrics come from the equity curve; cycle figures are listed as not applicable.
- **Not wired yet** (O265): the worker's back test job and the results page still take the rules
  form; they call this engine from P3, when state machines can be saved.

## Checks (P2b)

- `packages/backtest/src/machine-engine.test.ts`: A4 on a small machine (signal on a separate
  instrument, held prices fixed): a switch fills at the next open with the sell first; a switch
  under the 5% band places no orders; a 0.3% leg is skipped while the other trades; a partial
  buy completes on the next close and nothing trades after; stuck after 5 days; superseded; a
  price-collar cancel retried; a drawdown halt skips buys but sells. Cash is never negative.
- The worked example on a 1,500-day synthetic walk: the engine's switches from day 400 equal
  `replayMachine` over all the bars, start state included; Why lines recorded; A3c visits
  TOP_ESCAPE, DESPAIR, DESPAIR_HV, ATTACK, NORMAL, HI, HI_CASH and BEAR_CASH; the risk-off lock
  holds; a day with no QQQ bar is a stay with no order planned. A5: no transition or fill before
  MA200 exists. The series plan loads about 20 years of daily QQQ for `ath_drawdown` window 0.
- A3a and A3b wait for P0's inputs (O265).
- A1: domain (719) and back test (261, including `a1-reference.test.ts`) suites pass; worker and
  web suites run in CI.

## Decision: Phase P3a (paper runtime)

- **Stored beside the rules form** (N390). `createStrategy`, `updateStrategy`, versions, Lab
  numbers, copies and shares take a state-machine document (`parseAnyDefinition`). A save of the
  other form is refused: a rules strategy never becomes a state machine in place. Readers of Entry
  and Exit get a carrier, `machineCarrier`: the machine's execution and collar with no conditions
  or legs, and `StrategyDetail` carries `form` and `machine` beside it. The instrument index lists
  the signals and targets (`machineInstrumentUses`). The app's back test job refuses machines until
  P3b can show their results (O267).
- **One pass, one evaluator** (N391). `RuntimeWork.machine` sends the run to `planMachinePass`
  instead of `planPass`. It loads daily bars for every series the rows read and decides each close
  not yet decided with `decideDay` and `machineView`, the functions the back test uses. Days are
  counted on the NYSE calendar (O266). The state is kept in `runtime.state.machine`: the start
  state and day, the switches, the last decided close, the proposal, the confirmation and the
  active transition.
- **Replay at Start** (§2.9, N391). The first pass reads the feed directly from 1990-01-02 (the
  shared bar cache keeps only recent bars; a gap of more than 2 closes reads the feed again) and
  replays every bar from the fallback state with no orders (O268). It stores a proposal (the state,
  since when, the switches, the rebalance legs and the equity) and notifies the person. Only
  `confirmMachineStart` (POST `/api/v1/strategies/{id}/runs/{runtimeId}/confirm-start`, the Confirm
  Start button) lets the next pass adopt the state and place the Start rebalance.
- **Transitions** (§2.6, N392). Each Start and switch is a `strategy_transition` row (migration
  0121, tenant RLS): kind, decided day, from and to, deciding row, Why lines, outcome, rounds and
  completion day. A transition that trades gets its own cycle so its orders use the order-intent
  path. Rounds sell first, then buy from the cash the sells left; a new round starts at a later
  close while legs are over the band, stuck after `COMPLETION_DAYS` (5) trading days with a
  notification and an audit row. A newer switch supersedes the active one and cancels its working
  orders; after a gap only the newest switch trades. A leg timeout cancels the order.
- **Risk** (§2.8, N392). `machineRiskProfile` turns the % of equity limits into dollars at the
  current equity for `checkPreTradeRisk`; buys also check the account's exposure limit; the price
  collar and the open-collar hold apply as on the rules form. Sells count as exits and buys as
  entries for halts, so a halted or paused run decides and records but places nothing. There is no
  strategy trailing stop and no daily loss default (O262).
- **Start warning** (`machine_shared_account`, §7). Start warns when another run on the same
  account trades one of the machine's targets, since the account's holdings would be shared.

## Checks (P3a)

- `apps/worker/test/machine-runtime.test.ts` (Postgres): a machine saves and reads back with its
  carrier, Lab number and a refused rules save; Start replays with no orders and proposes; **A6**:
  the paper switches from 2015-01-02 to 2026-10-06 equal `simulateMachine`'s switch transitions
  over the same bars, and the final state matches; after confirm the Start buys go out at the
  open and the transition completes with no drift repair; a forced switch sells before it buys; a
  paused run decides and places nothing; Start warns on a shared account.
- A1: domain, back test, db (386 integration) and worker (269 integration) suites pass; the rules
  form's runtime tests are unchanged.
- P3b next: the builder, the run view and state stays in back test results and Performance.

## Decision: Phase P3b (builder, run view, state-stay reporting)

- **Back tests in the app** (N393). `startBacktest` takes a machine (`isMachineDefinition`), checks
  it with `validateMachine`, fits its inputs to daily bars and at most 5 years (`fitMachineInputs`;
  a symbol subset is refused) and checks the workload with `planMachineSeries`. The worker's job
  sends `RunWork.machine` to `runMachine`, which loads the bars and stores `simulateMachine`'s
  result (`machine@1`). Closes O267 and the app wiring of O265.
- **Results by state** (N394). `BacktestResults` shows a States section for `result.machine`:
  totals per state (`stateTotals`), every transition with its deciding row and Why lines
  (`TransitionsTable`, `WhyLines`), and every stay. Win rate, profit factor and cycles read "Not
  applicable"; the phase reports are hidden.
- **Run view** (N395). The run card shows the current state and its day count
  (`tradingDaysBetween` from the state's start to the last decided close, plus 1), the last
  transition with its Why lines, the transitions, and the stays since Start from `machineStays`.
- **Performance** (N396). `machineStays(tx, runtimeId, today)` walks the run's switches from the
  day it started trading and prices each stay with the strategy's daily P/L
  (`performanceTimeseries`); stays on paper report dollars, not % (O269). GET
  `/api/v1/strategies/{id}/machine-stays` feeds a States card on Performance, and
  `performanceLayout(summary, true)` turns win rate, average gain / loss and profit factor into "Not
  applicable".
- **Builder** (N397, brief §5). `MachineBuilder` edits a draft of the whole document and saves it
  with one update: signals, state cards (holdings in words, where each state is entered or read,
  removal blocked while referenced), rows in priority order with up and down, each reading as one
  sentence with its rule folded below (open for a new rule or a problem), risk and execution
  collapsed. The condition editor gains "+ State is", "+ Same rule as a row" and a "Left side
  reads" choice for days in the state. Schema problems show before the save; the server's
  validation shows after. A running strategy's builder is read only. New strategy offers "A blank
  state machine" (`createMachineDefinition`).

## Checks (P3b)

- `apps/worker/test/machine-runtime.test.ts`: a machine back test started in the app runs on the
  machine engine and its transitions equal `simulateMachine`'s over the same inputs; inputs beyond
  5 years are refused.
- `apps/web`: `stateTotals` and `performanceLayout(…, true)` unit tests; the builder was tried on a
  local copy (the §4 machine renders, a state rename saves and reloads; a blank state machine is
  created from New strategy and lists its two problems).
- Domain, back test, db and worker suites pass.
- Accepted by Yong on 2026-11-28 (PASS, checked independently on staging); O269 confirmed as the
  standing treatment.

## Start dialog fix (N398, 2026-11-28)

- Start adds `machine_shared_account` only when it checks a run on a chosen account, but the Start
  dialog listed the page's warnings, checked with no account, so the warning had no checkbox and
  Start was refused. The dialog now asks `validate?accountId=` for the chosen account and shows that
  account's warnings; a state machine's summary shows its traded instruments, rebalancing and its %
  of equity limit instead of the carrier's empty Entry and Exit.

## A3a and A3b on real bars (P0 inputs, 2026-11-28)

- **Bars stay out of the repository** (Yong's choice 2026-11-28). Vendor terms (Yahoo is
  personal-use; an Alpaca export raises the same question) keep the bar files local; only the
  expected sequences, facts derived from the bars, are checked in.
  `packages/domain/src/strategy/machine-real-bars.test.ts` replays the §4 example over a CSV named by
  `A3A_QQQ_BARS` or `A3B_QQQ_BARS` and is skipped without one, so CI does not run it.
- **A3a** checks the 2020 sequence (HI, HI_CASH, DEFEND, ATTACK_HV, NORMAL_HV, NORMAL) and each
  switch's month part, since the PDF gives month parts only, not dates. It also checks the late-March
  lock: DEFEND holds on Mar 26, 30, 31 and Apr 2 (the MA20-slope leg) and releases to ATTACK_HV on Apr 6. It does not test the anti-V days constant: the days count was past 3 by then, so that constant
  rests on the PDF's wording under §2.1 counting and on A3c.
- **A3b** checks the Feb–Jun 2025 sequence computed independently by the P0 pack over bars from June
  2023, provisional until Yong signs it off. Over staging's Alpaca daily bars (unadjusted, IEX
  volumes) from 2023-06-01, the engine's replay matched it exactly.
