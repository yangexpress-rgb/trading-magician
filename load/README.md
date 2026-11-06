# Load test

Checks the §19 targets Yong approved: 20 people with 5 strategies each, 10 back tests running at
once, pages at p95 under 1 second, and paper orders submitted within 5 seconds of their trigger.

It needs [k6](https://k6.io) and an app to point at. The recorded run is against **staging**
only; never production, because it signs accounts up and queues back tests. Staging must have
`SIGNUP_MODE=open` on web for the seeding step (set it, seed, then remove it again).

```sh
# 1. Prepare the data: 20 accounts, 5 strategies each (needs staging's owner connection).
APP_URL=https://<staging domain> DATABASE_URL='<staging owner URL>' \
  pnpm --filter @tm/db load:seed 20 5            # writes load/users.json

# 2. Run it, keeping the full report.
k6 run -e BASE_URL=https://<staging domain> --summary-export=load/report-<date>.json load/journey.js \
  | tee load/report-<date>.txt
```

`journey.js` signs in as each account, reads Strategy Lab, Orders and Performance, starts back
tests up to 10 at a time and waits for them, then reports:

- `http_req_duration{kind:page}` p95, which must be under 1000 ms,
- `backtest_wait` for queued back tests,
- `checks` must be 100%.

The order-within-5-seconds target is measured by `load/orders.sql` after a paper run: it compares
each order's trigger time with the time it was submitted. Run it against the same database:

```sh
psql "$DATABASE_URL" -f load/orders.sql
```

Record the date, the numbers and the environment in the project after each run; there is no
automated gate, because k6 is not installed in CI.

Record each run in `docs/launch-checks.md` (Section 6): date, staging's Railway plan and service
sizes, the profile above, each target met or missed, and for a miss whether the evidence points
at application code, worker capacity or Railway resource limits.

**Gap to settle before the recorded run:** `journey.js` does not start any paper strategies, so
the order-within-5-seconds target only has data if paper strategies are running on staging
during the run (start a few by hand, on the built-in paper account with an Alpaca feed, before step 2).
