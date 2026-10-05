# Load test

Checks the §19 targets Yong approved: 20 people with 5 strategies each, 10 back tests running at
once, pages at p95 under 1 second, and paper orders submitted within 5 seconds of their trigger.

It needs [k6](https://k6.io) and an app to point at. Use staging, or a local server; never
production, because it signs accounts up and queues back tests.

```sh
# 1. Prepare the data: 20 accounts, 5 strategies each (needs the owner connection).
pnpm --filter @tm/db tsx ../../load/seed.ts            # prints load/users.json

# 2. Run it.
k6 run -e BASE_URL=http://localhost:3000 load/journey.js
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
