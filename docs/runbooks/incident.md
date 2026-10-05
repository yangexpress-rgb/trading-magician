# Incident

1. **Look at the health check.** Open `https://<web domain>/api/health/system`.
   - `database: "unreachable"`: open the Postgres service in Railway. If it is restarting or
     out of disk, fix that first; the app recovers on its own once it answers.
   - `worker: "stale"` or `"never_seen"`: follow [stuck-worker.md](stuck-worker.md).
   - It does not load at all: the web service is down. Check its latest deployment; if a deploy
     broke it, use Redeploy on the last good deployment.
2. **Stop trading if in doubt.** Paper orders are placed only by the worker. Removing the worker's
   deployment (or setting its replicas to 0) stops every strategy from acting; nothing is
   cancelled and nothing restarts by itself. Each person can also engage the kill switch on
   Orders, which pauses only their strategies.
3. **Find the error.** Sentry shows the newest errors by environment. Railway logs carry the
   same error with the route or loop that failed.
4. **Fix or roll back.** Prefer redeploying the last good build over a hurried fix. Migrations
   only ever add, so an older build runs against a newer schema.
5. **Tell people** if it lasted more than a few minutes or affected orders: what happened, what
   they might see (for example a strategy paused with a reason), and that nothing resumes by
   itself.
6. **Write it down** in the project: cause, timeline, what changes so it does not happen again.
