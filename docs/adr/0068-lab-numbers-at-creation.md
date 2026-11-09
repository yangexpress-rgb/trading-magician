# ADR 0068: Every Lab strategy is numbered when it is created; Theory column; sort by number

- **Status:** accepted
- **Date:** 2026-11-09
- **Design refs:** design v1.2 rows N186 to N188, open point O136. Amends ADR 0065 and ADR 0066

## Context

On 9 November 2026 Yong asked: "1. every strategy should be assigned a strategy number when
created. 2. in the strategy lab, please separately give one column for the referred theory with
its theory number. if one strategy didn't create with a reference theory, leave it blank. 3. In
the strategy lab, please sort the strategy by ascending order of strategy number."

Until now a Lab number was issued on the first save with instruments, because its two letters
(asset class, timeframe) come from what the strategy trades, and test fixtures had none.

## Decision

- **Numbered at creation (N186).** Every strategy, fixtures included, gets its S number in the
  transaction that creates it (and on copy and accepted share, which create one). A draft that
  trades nothing yet gets the provisional letters SD (stock, daily), marked
  `lab_letters_settled = false` (migration 0081). The first save with instruments derives the real
  letters and settles them; the trigger lays the number out again from the same sequence, so
  S00005-SD may become S00005-ED once. The digits, the convention version and the issue time
  never change, and settled letters never change. Strategies still unnumbered are numbered on the
  deploy that adds this, after the migrations, oldest first.
- **Theory column (N187).** The Strategy Lab list has its own Theory column with the number of the
  theory the strategy refers to, linking to it. It is blank when the strategy's theory record was
  auto-created from the strategy (ADR 0054 D3: tagged auto-created and not received by sharing).
  The strategy header shows "Theory T…" on the same rule. The column sorts by theory sequence.
- **Sorted by number (N188).** The Lab list, and `GET /api/v1/strategies`, sort by strategy number
  ascending unless another sort or direction is asked for.

## Consequences

- A number seen on an empty draft can change its letters once; its digits identify it.
- Auto-created theory records still exist (ADR 0054); only their display in the Lab changes.
- A shared copy's theory is shown even if the sender's theory was auto-created, since the
  recipient's strategy was created from it.
