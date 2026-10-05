# ADR 0023: Billing with Stripe

- **Status:** accepted
- **Date:** 2026-10-05
- **Design refs:** §4.3, §13.1, §14, §16.1, §19.8

## Context

§4.3 asks for a subscription provider such as Stripe Billing, with webhooks that are
authoritative, signature-verified and idempotent. Yong approved Stripe in test mode, with Stripe's
hosted Checkout and customer portal, on 2026-10-05. Going live waits for his word.

## Decision

- **Test mode only.** `@tm/billing` talks to Stripe's REST API over `fetch` (no SDK) and refuses any
  key that is not `sk_test_…` or `rk_test_…`, as the broker adapters refuse live hosts (ADR 0002).
  The web and worker environments check the same.
- **Hosted pages.** `POST /api/v1/billing/checkout-session` opens Stripe Checkout for an offered
  paid plan; `POST /api/v1/billing/portal-session` opens the customer portal for card changes,
  invoices and cancelling. Card details never reach the app. Plans name their Stripe price in
  `plan.stripe_price_id` (ADR 0022).
- **Webhooks are a nudge; the provider is the record.** `POST /api/v1/webhooks/billing` checks the
  `Stripe-Signature` HMAC with a 5-minute tolerance, then reads the subscription back from Stripe
  and applies that. So events may arrive late, twice or out of order and the result is the same.
  Each event id is stored in `billing_event`; a replay is acknowledged and changes nothing. Unknown
  events are acknowledged and ignored. A late event about an older subscription never replaces a
  newer one that is paying.
- **Who it belongs to.** Checkout puts the user id in the session and subscription metadata. A
  webhook without it is matched to a workspace by customer or subscription id through
  `billing_user_for`, a narrow `SECURITY DEFINER` function, since webhooks have no session.
- **One way in.** The app cannot update `subscription` or `entitlement` directly. It calls
  `apply_subscription`, which only acts for the tenant the transaction is scoped to, stores the
  subscription and moves the entitlement's plan. Plan and status changes are audited; a plan
  change notifies the person with the always-shown `billing` kind.
- **Which plan.** Active, trialing and past-due subscriptions keep the plan their price pays for;
  anything else returns the workspace to the default plan (Free). ADR 0024 adds the grace period
  and what happens to running strategies.
- **Missed webhooks.** The worker re-reads each live subscription from Stripe hourly
  (`claim_subscription_syncs`) when it has `STRIPE_SECRET_KEY`.
- **Tests.** `@tm/billing/testing` has `FakeStripe`, which keeps sessions and subscriptions in
  memory and sends Stripe-shaped, signed events. With `BILLING_FAKE=true` (tests only; refused in
  production without `E2E_TEST`) the web app uses it and serves stand-in checkout and portal pages
  under `/billing-fake`, so end-to-end tests run the real webhook path without network or keys.

## Consequences

- Stripe API changes show up in `readSubscription` and `readEvent`, which accept both the older
  and the 2025 shapes of a subscription's period and an invoice's subscription.
- Moving to live mode will need a reviewed change to the key check, with legal review (§16.4).
