# Runbooks

Steps for when something goes wrong in staging or production (Design v1.0 §17.3, ADR 0025).
Everything here is paper trading; no real money is ever at risk, but people's paper results and
data are.

| Runbook                                      | Use it when                                                         |
| -------------------------------------------- | ------------------------------------------------------------------- |
| [incident.md](incident.md)                   | Anything is down or wrong and you are not sure where to start       |
| [stuck-worker.md](stuck-worker.md)           | The uptime check says the worker is stale, or nothing is happening  |
| [feeds-and-brokers.md](feeds-and-brokers.md) | Prices stop, a broker stops answering, or reconciliation mismatches |
| [billing-webhooks.md](billing-webhooks.md)   | Payments or plan changes are not showing up in the app              |
| [backups.md](backups.md)                     | Checking backups, the monthly restore test, or restoring for real   |
| [key-rotation.md](key-rotation.md)           | A secret may have leaked, or it is time to rotate one               |

Where to look:

- **Railway**: each service's Deployments and Logs tabs. Logs are JSON; filter with
  `@level:50` for errors or by a field such as `@msg:"heartbeat failed"`.
- **Sentry**: errors from web and worker, tagged by environment and commit.
- **Uptime monitor**: `https://<web domain>/api/health/system` (200 healthy, 503 not).
