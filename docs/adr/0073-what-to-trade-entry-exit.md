# ADR 0073: What to trade, Entry, Exit

- **Status:** accepted
- **Date:** 2026-11-10
- **Design refs:** design v1.2 rows N206 to N214, open points O142 to O148. Amends ADR 0049
  (D3, the Entry trigger and Regime gate labels, and §2.6's exits on every bar), ADR 0059
  (`keepHoldings`) and ADR 0067 (where the schedule lives)

## Context

On 10 November 2026 Yong asked for a strategy to be built in three parts: what to trade (a
specified asset with no filter, or a group with an optional filter and then an optional ranking),
Entry (when and how often it is checked, its conditions, its orders) and Exit (the same). Until
then, what a strategy traded was decided in three places inside Entry (fixed legs, per-leg
conditions, and a Selection group of the universe or of the legs), the one condition box was an
"Entry trigger" or a "Regime gate" depending on that choice, and Exit had no schedule of its own.
A Selection group's rebalance exit was switched off from the Entry side ("Keep each pick until its
own exit"), and its order amount was a total split over N.

The proposal ("Strategy restructure: What to trade, Entry, Exit", Claude Doc, 2026-11-10) was
approved as recommended the same day.

## Decision

- **Schema 3.** A top-level `trade`: `{ kind: 'assets' }` or
  `{ kind: 'group', universe, filter?, ranking?: { metric, params, direction, count }, splitTotal? }`.
  `entry.kind` and `entry.selection` go. The schedule moves from the definition to
  `entry.schedule`; Exit gets `exit.schedule`.
- **Specific assets are the Entry legs' instruments.** They are not stored twice: the What to
  trade card edits the legs' instruments directly (replacing one rewrites every reference to it).
  Two or more assets are entered and exited together, as fixed multi-leg strategies always were
  (O142).
- **A group** filters, then ranks, at each Check Entry (O143). Without a ranking every member that
  passes is a candidate in symbol order, up to `risk.maxInstrumentsHeld`, which such a group must
  set (O147).
- **Enter when** is one box. With a group, a condition that reads "this stock" is evaluated for
  each candidate; one on named symbols is a gate for all of them. Holdings still in the group are
  not sold because they fail Enter when at a later check.
- **Check Exit.** Exit when, the exit rules and the time stop are checked when `exit.schedule` is
  due; when it is absent they are checked on every bar the run steps on, exactly as before.
  Positions, fills and the trailing stop's high keep updating on every bar. A new group gets
  `suggestedExitSchedule(entry)`: the same as Entry, or daily when Entry is a calendar period
  (O145). Stops still read daily closes; reading closes at the Check Exit bar size is build 2
  (O144).
- **Left the group** (`{ kind: 'leftGroup' }`) is an exit rule for groups. Its absence is the
  former `keepHoldings: true`.
- **Group amounts are per pick** unless `trade.splitTotal` (O146).
- **Per-leg conditions and ranked legs** (D3) leave the builder. Saved strategies that use them
  keep them as saved (`entry.rankedLegs`, `legCondition`) and run as before (O148).
- **Converted on read.** `migrateV2` (in `parseDefinition`, as `migrateV1` in ADR 0049) gives the
  same strategy in schema 3 with a note per conversion; stored documents and their draft hashes
  are not rewritten. A Selection group becomes a group (pre-filter → filter); without
  `keepHoldings` Exit gains Left the group; a total over a fixed N becomes total ÷ N per pick, to
  the 10 decimal places the engines divided to; a total over a top N% keeps `splitTotal`.

## Consequences

- The regression corpus replays every fixture from schema 1 through schema 3 with the same
  decisions, orders, fills and metrics, and a schema 2 Selection group back tests exactly as its
  schema 3 form. No database migration (0084 stays free).
- Deviation from the proposal: uniform per-leg conditions and uniform ranked legs are kept as
  saved rather than converted to list groups, because a list group enters new picks while others
  are held, which those strategies never did.
- Paper state gains `lastExitSchedulePeriod`, kept in the runtime state JSON.
- "Earnings breakout (test)" reads as a group over the S&P 500 with its filter and a top 10
  ranking, $2,000 per pick, no Left the group rule, Check Entry daily and Check Exit on every bar.
