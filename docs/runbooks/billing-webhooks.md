# Billing webhooks

Stripe tells the app about payments through `POST /api/v1/webhooks/billing`, and the worker also
re-reads each live subscription from Stripe every hour (ADR 0023), so a missed webhook heals
within an hour. Test mode only.

1. **Someone paid but is still on Free.** In Stripe (test mode) → Developers → Webhooks → the
   endpoint → recent deliveries.
   - `400 signature`: `STRIPE_WEBHOOK_SECRET` on web does not match the endpoint's signing
     secret. Copy it again from Stripe, update Railway, redeploy web, then press Resend on the
     failed deliveries.
   - `5xx` or timeouts: look in Sentry and the web logs for `"Billing webhook failed"`. Fix the
     cause, then Resend. Replays are safe; each event is applied once.
   - No deliveries at all: the endpoint URL or its event list is wrong; compare with
     `docs/deploy.md`.
2. **Wrong plan after a resend.** The app always reads the subscription back from Stripe, so
   Stripe's view wins. Check the subscription's status and price in Stripe, and that the plan's
   `stripe_price_id` matches that price (`select code, stripe_price_id from plan`).
3. **Payment failed.** The person keeps their plan for 7 days with notices on days 0, 3 and 6,
   then moves to Free, and strategies over Free's limits pause (ADR 0024). Nothing to do unless
   they ask; an updated card in the portal ends the grace period at once.
4. **The hourly re-sync is not running.** The worker needs `STRIPE_SECRET_KEY`; look for
   `"billing jobs failed"` in its logs.
