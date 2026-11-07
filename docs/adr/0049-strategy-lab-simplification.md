# ADR 0049: Strategy Lab simplification — one job, one control, one implementation

- **Status:** accepted
- **Date:** 2026-11-07
- **Design refs:** §6.4 to §6.10, §7.3; design v1.2 rows N67 to N84, open points O49 to O60;
  the Strategy Lab simplification brief and its review (decisions D1 to D7, approved by Yong on
  2026-11-07). Supersedes parts of ADR 0028 (the Exit mirror), ADR 0040 (fire mode) and ADR 0045
  (where the ATR distance is entered)

## Context

The review of the Strategy Lab found the same job done by two mechanisms (two risk quantity
types, RSI as an indicator and a metric, best-by-metric beside Selection groups), one concept
split across several controls (the ATR distance on the leg and on the stop; trigger mode and
confirmation bars; extended hours per leg and per strategy; timed legs per leg), controls that
were hidden but active (the Exit trigger of a Selection group, the "Exit follows Entry" state)
and controls that offered what validation rejects. It also found `once_per_cycle` meant "once
per run". Every capability had to survive, and every saved strategy had to behave as before.

## Decision

- **Schema 2, migrated on read.** `STRATEGY_SCHEMA_VERSION` is 2. Stored drafts and versions
  are never rewritten: `parseDefinition` runs `migrateV1` (`packages/domain/src/strategy/
migrate-v1.ts`) on every schema 1 document, and the new shape is what the app, the back test
  and the paper runtime see. `migrateV1` returns a note per conversion with its effect: `same`,
  `grandfathered` (an old form kept that the builder no longer offers) or `changes`. Stored
  draft hashes are kept, so a migrated strategy is not "changed since its back test".
  `pnpm --filter @tm/db strategies:migration-report` lists every converted strategy, every
  grandfathered Exit-leg stop order and every strategy a new check now refuses.
- **One risk distance per Entry (D1).** `entry.risk {atrPeriod, atrMultiple}` is entered once.
  A leg risk-sized from the ATR reads it; the ATR stop reads it too unless it has an explicit
  `override`. The leg keeps its risk amount (O49).
- **One risk quantity (§2.7).** `risk` with `amountIn` (dollars or % of equity) and
  `distanceFrom` (the leg's stop price or the Entry's ATR distance) replaces `risk_sized` and
  `risk_atr`. Sizing is unchanged for both old types.
- **One computation per name (D2).** The RSI metric gains an interval and bars ago, so it covers
  every RSI the indicator did on regular-session, split-and-dividend closes; Bollinger bands are
  the statistics BB_UPPER, BB_MIDDLE and BB_LOWER. Saved RSI and BBANDS indicators are rewritten
  to those, keeping their node ids; unusual ones (another field or session) are kept as saved.
  The builder no longer offers RSI or BBANDS as indicators (`BUILDER_INDICATORS`).
- **Best by metric is a Selection group of these legs (D3).** A new universe `{type: 'legs'}`
  ranks the Entry legs' instruments; each leg keeps its quantity, side, account and conditions
  (its pre-filter). It runs through the per-leg slot machinery, so a converted strategy backtests
  exactly as before (O50). `fireMode` and `weighting` are gone.
- **Triggers.** `once_per_cycle` is fixed, not deleted (D4): a non-slot cycle that closes or is
  aborted re-arms its group's Entry trigger (`rearmEntryTrigger`) in both engines. The cooldown
  is counted in bars (`cooldownBars`, evaluations): N bars block the N − 1 evaluations after a
  firing. A crossing with confirmation bars is an error (`cross_with_confirmation`). The builder
  sets mode and confirmation in one "Fire when" control.
- **Slot-mode Exit fires directly (§2.6).** Selection groups and per-leg strategies have no
  `exit.trigger`: their Exit condition exits on every bar it is true (`exitFiresDirectly`).
- **One entry path (§2.12, D6).** `planEntry` decides every non-slot evaluation in the back test
  and on paper: a new cycle, a pyramid batch, a cycle that a timed leg opened now getting its
  Entry trigger (`trigger_cycle`), or a timing-only exact Entry leg opening a cycle. Timed legs
  go on timing alone only under the strategy switch `execution.timingOnly` ("Allow timed entries
  without conditions").
- **Extended hours (D5)** is the strategy's market-hours policy only; the per-leg flag is gone.
- **Exit mirror (§2.8)** is the visible switch `exit.mirrorEntry`. On, Entry edits regenerate the
  Exit legs and they are not edited by hand; off, they are hand-built.
- **Exit legs (D7)** are market, limit or close orders in the builder. A saved Exit leg with a
  stop or stop-limit order keeps working as saved (grandfathered, listed by the report).
- **Labels and layout.** Direction is derived from the legs and shown, never stored. The Entry
  condition is the "Entry trigger" without slots and the "Regime gate" with them, where "this
  instrument" is refused (`context_in_gate`). The time stop is the "Holding-period exit". A
  Selection group's quantity is "Total amount (split equally)" with the per-instrument amount
  beside it. The schedule and the risk distance sit in the Entry card; the Exit card has one
  "Exits" list with a read-only "Rebalance exits" row when a rebalance applies. The disabled
  Weighting select is gone; the leg timeout shows only with a multi-leg phase; further entry
  groups sit behind a summary row. `risk.maxOpenPositions` is `maxInstrumentsHeld`.

## Consequences

- Proven by a regression corpus recorded before the change: all 59 fixture back-test runs
  (`packages/backtest/src/fixtures/corpus-v1.json.gz`, every run of every test except the
  property tests) re-run from their schema 1 definitions after the migration with identical
  behaviour: the same decisions, orders, fills, trades, equity and metrics
  (`corpus.test.ts`). The three original SPY strategies give their recorded results.
- Behaviour changes are deliberate and reported per strategy: cooldowns that weren't whole days,
  market legs that asked for extended hours, timed legs that waited for conditions beside a
  timing-only leg, a non-default hidden Exit trigger on a slot strategy, and a stored direction
  that disagreed with the legs (O52 to O58).
- The paper runtime keeps its trigger state while paused; stopping and starting creates a new
  runtime with a fresh trigger (O53).
