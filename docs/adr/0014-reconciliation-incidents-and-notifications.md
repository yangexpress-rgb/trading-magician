# ADR 0014: Reconciliation, incidents, automatic pauses and notifications

- **Status:** accepted
- **Date:** 2026-10-04
- **Design refs:** §8.5, §8.6, §16.2, §16.3, §19.6

## Context

Paper strategies place orders on their own (ADR 0012) and people watch them in Orders (ADR 0013).
When the app's records and the broker's disagree, or the broker or prices go quiet, trading
must stop until someone has looked, and the person must hear about it without watching the
screen. Every execution step must also leave an audit record (§16.2).

## Decision

- **Incidents.** `execution_incident` records a reconciliation mismatch, repeated rejects,
  stale data, feed loss or a broker that does not answer. A partial unique index keeps one open
  incident per kind, runtime and account, so a lasting problem is reported once. Opening one can
  pause the running strategies it affects (`runtime.auto_paused`); a strategy that starts trading
  the same account while it is open is paused too. Data problems resolve themselves when they
  pass; mismatches and repeated rejects are resolved by a person, with an optional note, from the
  Orders banner. Resolving does not resume anything: each strategy is resumed on purpose.
- **Reconciliation.** Every `SAFETY.reconcileEveryMs` (60 s), and at once when the broker reports
  an order the app does not know, the worker polls working orders and compares positions built
  from fills with the broker's. Updates it finds are applied with source `reconciliation`
  (audited as healed). Orders the broker no longer has, positions that differ, and unknown orders
  open a mismatch incident and pause the affected strategies (every strategy on the account for
  unknown orders).
- **Automatic pauses (§8.6).** Defaults, single constants in `apps/worker/src/runtime.ts`:
  3 rejected or failed orders in a row since the last resume; prices stale past the strategy's
  threshold for another 60 s (flagged at once, paused after); the broker not answering for 60 s.
  Daily loss and drawdown limits keep pausing as before and now notify.
- **Audit (§16.2).** Start, stop, triggers, risk approval and rejection, submission, every order
  state change, cancel requests, kill switch, reconciliation, incidents, pauses and resumes write
  append-only `audit_log` records with no secrets.
- **Notifications (§16.3).** `notification` rows for start, stop, Entry and Exit triggers,
  rejections, partial and full fills, disconnects, stale data, risk pauses and reconciliation
  mismatches. Each carries a dedupe key so a retried pass cannot repeat one, and a relative link
  to where to look. They are in-app only (Phase 3 default for §20 #13): a Notifications link with
  the unread count in the header, a page listing them, and live updates over the same
  `tm_execution` channel. The `tm_app` role can only change `read_at`.

## Consequences

- Email or push can be added later as delivery channels reading the same rows.
- The safety thresholds are proposals awaiting confirmation; changing one is a one-line edit.
- Repeated-reject counting uses the runtime's `resumed_at`, so a resume gives a clean slate.
