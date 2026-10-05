#!/bin/sh
# Monthly restore test (docs/runbooks/backups.md): restores a backup into a
# throwaway database and checks it holds what it should, then drops it.
#
#   restore-check.sh <dump file>        restore a local file
#   restore-check.sh latest             fetch the newest backup from R2 first
#
# ADMIN_URL: a connection that may create databases and roles (the owner).
set -eu

: "${ADMIN_URL:?ADMIN_URL is required (a connection that may create databases)}"
source_arg="${1:?usage: restore-check.sh <dump file>|latest}"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

if [ "$source_arg" = "latest" ]; then
  : "${R2_ENDPOINT:?R2_ENDPOINT is required}" "${R2_BUCKET:?R2_BUCKET is required}"
  PREFIX="${BACKUP_PREFIX:-${RAILWAY_ENVIRONMENT_NAME:-production}}"
  export AWS_DEFAULT_REGION="${AWS_DEFAULT_REGION:-auto}"
  latest=$(aws --endpoint-url "$R2_ENDPOINT" s3 ls "s3://$R2_BUCKET/$PREFIX/" | awk '{print $4}' | grep '^tm-.*\.dump$' | sort | tail -n 1)
  [ -n "$latest" ] || { echo "restore-check: no backups found" >&2; exit 1; }
  echo "restore-check: fetching $latest"
  aws --endpoint-url "$R2_ENDPOINT" s3 cp --only-show-errors "s3://$R2_BUCKET/$PREFIX/$latest" "$work/$latest"
  dump="$work/$latest"
else
  dump="$source_arg"
fi

db="tm_restore_check_$(date -u +%Y%m%d%H%M%S)"
psql_admin() { psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -q "$@"; }

# Roles are cluster-wide, so a dump does not carry them; create the group roles
# the schema grants to, as the first migration would.
psql_admin <<SQL
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tm_app') THEN CREATE ROLE tm_app NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tm_auth') THEN CREATE ROLE tm_auth NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tm_secrets') THEN CREATE ROLE tm_secrets NOLOGIN; END IF;
END \$\$;
CREATE DATABASE $db;
SQL
cleanup() { psql_admin -c "DROP DATABASE IF EXISTS $db" || true; rm -rf "$work"; }
trap cleanup EXIT

target=$(printf '%s' "$ADMIN_URL" | sed -E "s#/[^/?]*(\?|$)#/$db\1#")
echo "restore-check: restoring into $db"
pg_restore --no-owner --exit-on-error --dbname="$target" "$dump"

echo "restore-check: checking contents"
psql "$target" -v ON_ERROR_STOP=1 -At <<'SQL'
SELECT 'migrations applied: ' || count(*) FROM drizzle.__drizzle_migrations;
SELECT 'users: ' || count(*) FROM "user";
SELECT 'strategies: ' || count(*) FROM strategy;
SELECT 'orders: ' || count(*) FROM order_intent;
SELECT 'audit events: ' || count(*) FROM audit_event;
SELECT 'newest audit event: ' || coalesce(max(occurred_at)::text, 'none') FROM audit_event;
SELECT 'plans: ' || string_agg(code, ', ' ORDER BY code) FROM plan;
SQL
echo "restore-check: OK"
