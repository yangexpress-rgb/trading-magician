# ADR 0008: Back-test engine

- **Status:** accepted
- **Date:** 2026-10-04
- **Design refs:** §6.5–§6.9, §7.2, §8.6, §20 #6

## Context

Back tests must use the same rules as live execution, never see a price before
it exists, and give the same answer for the same inputs so results can be
explained later (§7.2).

## Decision

- `@tm/backtest` is a pure, synchronous function `simulate(definition, instruments, inputs, data)`.
  Loading bars (`planSeries`, `loadData`) is separate so the worker can page or cache data.
- Conditions are evaluated by the domain's `evaluateCondition`, the same code the runtime will use,
  through a `MarketView` that only exposes bars whose `end` has passed.
- The clock is the union of execution-bar ends. At each step the engine fills working orders on the
  bar that just closed, charges borrow and applies halts, expires and times out orders, then evaluates
  Entry and Exit. An order placed at a close can only fill on a later bar.
- Fill model (proposed defaults for §20 #6, all editable per run): market at the next open plus
  slippage; limits at the limit or a better open once touched; stops at the stop or a gapped open plus
  slippage; at most a set share of each bar's volume; per-share commission with a minimum; daily borrow
  on shorts at each session close. No leverage: gross exposure may not exceed equity.
- The §8.6 risk limits run before every non-closing order. Closing orders always pass.
- Results carry `ENGINE_VERSION`, the data versions and plain-language assumptions.
  Any change to simulation semantics bumps `ENGINE_VERSION`.

## Consequences

- Property tests can change bars after any point and check nothing before it moves.
- Intrabar order of high and low is unknown, so a bar that touches both a stop and a limit is resolved
  by the rules above, not by a path through the bar. This is listed in the assumptions.
- Quote fields (bid, ask, mid, last) use the bar close; a warning says so.
