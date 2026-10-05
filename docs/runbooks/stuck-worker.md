# Stuck worker

The worker runs back tests, paper strategies, reconciliation, feed and broker checks,
valuations and billing jobs, and writes a heartbeat every 30 seconds. The system health check
reports it `stale` after 3 minutes without one.

1. **Is it running?** Railway → worker → Deployments. If it is crashing in a loop, open the logs
   for the first `"worker crashed"` line; Sentry has the same error with its stack.
2. **Is it connected?** A `"heartbeat failed"` warning every 30 s means it cannot reach Postgres
   or its login lost rights. Check `DATABASE_WORKER_URL` and that `DB_WORKER_LOGIN_PASSWORD`
   matches the shared variable; redeploying web reruns `db:setup-logins`.
3. **Is it alive but stuck?** Heartbeats keep coming but back tests stay queued or strategies do
   not move: look for repeated `"back test failed"`, `"runtime pass failed"`, `"runtime loop failed"` or similar
   warnings. Restart the worker (Deployments → Restart). Leases expire on their own, so another
   start picks the work up; nothing runs twice.
4. **Still stuck:** redeploy the last good worker build, then follow [incident.md](incident.md).

After a restart, paused strategies stay paused. People resume them from Orders.
