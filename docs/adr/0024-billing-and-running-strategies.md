# ADR 0024: Billing and running strategies

- **Status:** accepted
- **Date:** 2026-10-05
- **Design refs:** §4.3, §13.1, §19.8, §20 #4

## Context

§19.8 asks that subscription changes never create unsafe, silent execution behavior. A plan can
shrink while strategies run: a failed payment, a cancel at the end of the period, or a move to a
cheaper plan. Yong approved, on 2026-10-05, a 7-day grace period with notices on days 0, 3 and 6,
after which the workspace drops to Free and strategies over Free's limits pause; a downgrade or
cancel takes effect at the end of the period.

## Decision

- **Grace period.** When a subscription first turns `past_due` or `unpaid`, `applySubscription`
  sets `subscription.grace_ends_at` to 7 days later and keeps it for as long as the same
  subscription stays unpaid; paying clears it. The paid plan stays until then. The person gets an
  always-shown `billing` notice at once, and the worker sends reminders on days 3 and 6 (deduped
  per subscription, grace end and day) through `runBillingGrace`, which reads due workspaces from
  the narrow `SECURITY DEFINER` function `billing_grace_due`.
- **End of grace.** When the grace period has passed, the worker re-applies the stored
  subscription, which now resolves to the default plan. `apply_subscription` gains a
  `p_grace_ends_at` argument and remains the only way to write billing state.
- **Downgrade and cancel.** Stripe keeps the paid price until the period ends
  (`cancel_at_period_end`); the plan changes when Stripe reports the new state, not before.
- **Pausing, never stopping.** On any plan change `pauseStrategiesOverPlan` pauses, in one
  transaction under the user's limit lock:
  1. running strategies on an outside broker account when the new plan has no paper integrations,
  2. then the newest running strategies beyond the plan's active limit.
     A pause uses the existing paused state: no new entries are placed, and open orders and positions
     stay as they are for the person to manage. Each pause is audited as `runtime.paused` by the
     system with `cause: 'plan_limit'`, carries a reason the person can read ("The Free plan runs 1
     strategy at a time."), and the plan-change notice names the paused strategies.
- **Nothing restarts by itself.** An upgrade or a paid invoice never resumes a strategy. Resuming
  is the person's action and is checked against the current plan (`assertCanResume`), so a resume
  past the limit fails with `plan_limit`.

## Consequences

- A workspace never runs more than its plan allows for longer than one billing event or one
  worker tick (one minute) after the plan changes.
- Pausing rather than stopping keeps open positions under the person's control; a later phase may
  add a choice of which strategies to keep running.
