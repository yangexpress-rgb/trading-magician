# Backups and restore

A Railway cron service (`deploy/railway/backup.json`) runs `deploy/backup/backup.sh` every day at
07:30 UTC. It dumps the database, uploads it to R2 under `<environment>/tm-<time>.dump`, checks the
uploaded size and deletes dumps older than 30 days (ADR 0025).

## Check that backups run

Railway → backup service → Cron Runs. Each run's log ends with `backup: done`. A run that fails
exits non-zero, and Railway marks it failed. Look at it at least weekly until there is an alert.

## Monthly restore test

From a machine with `psql`, `pg_restore` and the AWS CLI (or the backup image itself:
`docker run --rm -it -e ... <backup image> restore-check.sh latest`):

```sh
export ADMIN_URL='<staging Postgres owner URL>'   # a database the test may create a scratch copy in
export R2_ENDPOINT='https://<account id>.r2.cloudflarestorage.com' R2_BUCKET='<bucket>'
export AWS_ACCESS_KEY_ID='<R2 read token id>' AWS_SECRET_ACCESS_KEY='<R2 read token secret>'
export BACKUP_PREFIX=production
deploy/backup/restore-check.sh latest
```

It restores the newest production dump into a throwaway database on the staging server, prints
counts of users, strategies, orders and audit events and the newest audit time, and drops the
copy. Note the result and date in the project. Never point `ADMIN_URL` at production.

## Restoring for real

1. Stop the worker (remove its deployment) so nothing writes while you restore.
2. Create a new Postgres service in the same environment.
3. Run `restore-check.sh`'s steps by hand against it: create the `tm_app`, `tm_auth` and
   `tm_secrets` roles, then `pg_restore --no-owner --exit-on-error --dbname=<new db URL> <dump>`.
4. Point web's and worker's database variables at the new service, and redeploy web: its
   pre-deploy step runs migrations (a no-op unless the dump is older than the code) and
   `db:setup-logins`, which recreates the login users.
5. Start the worker. Strategies that were running come back paused only if they were paused;
   reconciliation brings orders up to date with the brokers within a minute.
6. Tell people their data is as of the backup's time.
