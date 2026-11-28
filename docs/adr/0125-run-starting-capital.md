# ADR 0125: Starting capital chosen per run

- **Status:** accepted
- **Date:** 2026-11-28
- **Design refs:** N400; migration 0122. Amends the fixed paper capital of ADR 0012. Asked for by
  Yong on 2026-11-28 ("Yes, please, and also Please default it to $10,000").

## Context

Every paper run started with the same fixed $100,000 (`PAPER_STARTING_CAPITAL`). Sizing that
reads equity (a state machine's % of equity holdings, % of equity order sizes) and the
strategy's own limits (daily loss, drawdown, % of equity exposure) were all measured against
it. The amount was not shown anywhere and could not be chosen, so a strategy's orders could be
far larger than the person meant (S00069's 99% TQQQ state on $100,000).

## Decision

- **Each run keeps its own starting capital** (`strategy_runtime.starting_capital`, numeric,
  above zero). The run's equity is its starting capital plus the cash and positions from its
  own fills; `equityLimits`, the rules runtime and the state-machine runtime's rebalance cash
  all read `RuntimeWork.startingCapital` instead of the fixed figure.
- **Chosen in the Start dialog.** A "Starting capital ($)" field under the account, default
  **$10,000** (`DEFAULT_STARTING_CAPITAL`). It accepts $100 to $100,000,000 in dollars and
  cents; anything else is refused by the request schema and again by `startStrategy`
  (`transition_blocked`, reason `starting_capital`). A state machine's summary shows its %
  of equity limit in dollars at the start.
- **Start without the field** (the agent tools, older clients) also gets $10,000.
- **Existing runs keep $100,000.** Migration 0122 adds the column with that default, so runs
  started before it keep sizing as they did; new rows always carry the chosen amount.
- **Shown on the run**: the Execution section's run list reads "… · $25,000 starting capital".
- The amount is the run's own. It is not taken from, or checked against, the account's
  balance; account limits (ADR 0107) still apply to every order. Performance's account
  equity (ADR 0020, the built-in paper account at $100,000) is unchanged.

## Checks

- `packages/db/test/strategies.test.ts`: Start without an amount stores 10000 and the detail's
  run shows it; 25000.50 is kept; 0, 50, −1, text and 200,000,000 are refused with no run made.
- `apps/worker/test/machine-runtime.test.ts`: a state machine's Start rebalance on $50,000
  buys about five times the shares of the same machine on the default $10,000.
- `apps/worker/test/options-o3.test.ts` starts its runs at $100,000, the amount its figures
  were written for.
- Tried locally: the dialog shows $10,000, "Enter at least $100" for 50, and a run started at
  $25,000 lists "$25,000 starting capital".
